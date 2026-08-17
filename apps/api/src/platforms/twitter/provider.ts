import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { LetmepostError } from "../../errors.js";
import { encodeOAuthState } from "../../oauth/state.js";
import { authFailed, upstreamDetail } from "../_shared/errors.js";
import { platformFetch } from "../_shared/http.js";
import type {
  AccountProvider,
  ConnectContext,
  ConnectDescriptor,
  ConnectedAccount,
  RefreshInput,
  RefreshResult,
} from "../_shared/provider.js";
import { scopeSetFor } from "../_shared/scopes.js";
import {
  exchangeTwitterCode,
  refreshTwitterToken,
  TWITTER_API_BASE,
  TWITTER_OAUTH_AUTHORIZE_URL,
  type TwitterTokenResponse,
} from "./client.js";

/**
 * Twitter/X provider — OAuth 2.0 PKCE flow. Access tokens live ~2h; refresh
 * 15 minutes before expiry per plan.md Phase 8 sizing.
 *
 * What we persist after connect:
 *   - `token`         = short-lived access token (refreshed proactively).
 *   - `tokenMetadata` = `{ refreshToken, grantedScopes, tokenUrl?,
 *                         authorizeUrl? }`. Note: the PKCE `codeVerifier`
 *                         lives in the short-lived ConnectDescriptor
 *                         returned to the caller — it's NOT persisted; it's
 *                         only needed for the one-time code→token exchange.
 *   - `tokenExpiresAt` = now + expires_in seconds from the token response.
 */

const PLATFORM = "twitter";
const EXPIRING_HORIZON_MS = 15 * 60 * 1000;

export type TwitterProviderConfig = {
  clientId?: string;
  clientSecret?: string;
  /** Override the authorize URL for tests. */
  authorizeUrl?: string;
  /** Override the token URL for tests. */
  tokenUrl?: string;
  /** Override the API base (for `GET /2/users/me`) in tests. */
  apiBase?: string;
};

const CompleteConnectInput = z.object({
  code: z.string().min(1, "Twitter OAuth code is required."),
  state: z.string().min(1, "OAuth state is required."),
  redirectUri: z.string().url("redirectUri must be a URL."),
  codeVerifier: z.string().min(1, "PKCE codeVerifier is required for Twitter."),
});

export type TwitterTokenMetadata = {
  refreshToken?: string;
  grantedScopes?: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
};

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function computeRedirectUri(baseUrl: string): string {
  return new URL("/v1/accounts/oauth/twitter/callback", baseUrl).toString();
}

function expiresAtFrom(resp: TwitterTokenResponse): Date {
  return new Date(Date.now() + resp.expires_in * 1000);
}

/**
 * Build the metadata to persist alongside a fresh access token.
 *
 * `previous` matters on the refresh path. `updateToken` replaces
 * `tokenMetadata` wholesale, and X does not guarantee a `refresh_token` on
 * every refresh response (the field is optional in the OAuth 2 spec and X
 * omits it whenever it opts not to rotate). Building metadata purely from the
 * response therefore erased the stored refresh token on the first such
 * response — the next scheduled refresh then failed with "no refresh token
 * stored", emitted `token.revoked`, and left the account dead until the user
 * manually reconnected. Carry the previous value forward when the response
 * doesn't supply a new one.
 */
function toMetadata(
  resp: TwitterTokenResponse,
  config: TwitterProviderConfig,
  previous?: TwitterTokenMetadata | null,
): TwitterTokenMetadata {
  const md: TwitterTokenMetadata = {
    grantedScopes: resp.scope
      ? resp.scope.split(/\s+/).filter(Boolean)
      : (previous?.grantedScopes ?? []),
  };
  const refreshToken = resp.refresh_token || previous?.refreshToken;
  if (refreshToken) md.refreshToken = refreshToken;
  if (config.authorizeUrl) md.authorizeUrl = config.authorizeUrl;
  else if (previous?.authorizeUrl) md.authorizeUrl = previous.authorizeUrl;
  if (config.tokenUrl) md.tokenUrl = config.tokenUrl;
  else if (previous?.tokenUrl) md.tokenUrl = previous.tokenUrl;
  return md;
}

function readRefreshToken(
  tokenMetadata: Record<string, unknown> | null,
): string | null {
  if (!tokenMetadata) return null;
  const rt = (tokenMetadata as TwitterTokenMetadata).refreshToken;
  return typeof rt === "string" && rt.length > 0 ? rt : null;
}

type TwitterUser = { id: string; username?: string; name?: string };

/**
 * Resolve the authenticated user via `GET /2/users/me`. Its `data.id` is the
 * stable, upstream Twitter user id we pin as `platformAccountId` — so a
 * reconnect UPSERTs the same row instead of minting a duplicate. Requires the
 * `users.read` scope, which the connect flow always requests.
 */
async function fetchAuthenticatedUser(
  accessToken: string,
  apiBase: string,
): Promise<TwitterUser> {
  const res = await platformFetch<{ data?: TwitterUser }>({
    method: "GET",
    url: `${apiBase}/users/me`,
    headers: { Authorization: `Bearer ${accessToken}` },
    platform: PLATFORM,
  });
  const user = res.body?.data;
  if (!res.ok || !user?.id) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      message: "Could not resolve the authenticated X user (GET /2/users/me).",
      remediation:
        "Ensure the connect grant includes the users.read scope, then re-connect the X account.",
    });
  }
  return user;
}

export class TwitterProvider implements AccountProvider {
  readonly platform = PLATFORM;
  readonly expiringHorizonMs = EXPIRING_HORIZON_MS;

  constructor(private readonly config: TwitterProviderConfig = {}) {}

  describeConnect(ctx: ConnectContext): ConnectDescriptor {
    const scopes = [...scopeSetFor(PLATFORM).write];
    const codeVerifier = base64UrlEncode(randomBytes(32));
    const codeChallenge = base64UrlEncode(
      createHash("sha256").update(codeVerifier).digest(),
    );

    // Re-sign the state to embed the PKCE verifier. The dashboard does a
    // full-page redirect to Twitter immediately after this call returns,
    // so anything kept in client-side state vanishes. The signed state
    // round-trips through Twitter and back to our GET callback intact;
    // embedding the verifier here is what makes the exchange step recover
    // it.
    //
    // If `oauthStatePayload` isn't on ctx (test paths), fall back to the
    // pre-signed token from `ctx.oauthState`, then to a random UUID. The
    // first two paths drop the verifier — only acceptable for tests.
    const state =
      ctx.oauthStatePayload != null
        ? encodeOAuthState({
            ...ctx.oauthStatePayload,
            pkce: { codeVerifier },
          })
        : (ctx.oauthState ?? randomUUID());

    const redirectUri = computeRedirectUri(ctx.baseUrl);
    const url = new URL(
      this.config.authorizeUrl ?? TWITTER_OAUTH_AUTHORIZE_URL,
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.resolveClientId());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return {
      kind: "oauth",
      authorizationUrl: url.toString(),
      state,
      scopes,
      redirectUri,
      codeVerifier,
    };
  }

  async completeConnect(
    _ctx: ConnectContext,
    raw: unknown,
  ): Promise<ConnectedAccount> {
    const parsed = CompleteConnectInput.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: issue?.message ?? "Invalid Twitter connect payload.",
        rule: issue?.path.join(".") || "body",
        platformResponse: parsed.error.issues,
      });
    }
    const { code, codeVerifier, redirectUri } = parsed.data;
    const exchangeArgs: Parameters<typeof exchangeTwitterCode>[0] = {
      clientId: this.resolveClientId(),
      clientSecret: this.resolveClientSecret(),
      code,
      codeVerifier,
      redirectUri,
    };
    if (this.config.tokenUrl) exchangeArgs.tokenUrl = this.config.tokenUrl;
    const tokens = await exchangeTwitterCode(exchangeArgs);

    const user = await fetchAuthenticatedUser(
      tokens.access_token,
      this.config.apiBase ?? TWITTER_API_BASE,
    );

    return {
      platformAccountId: user.id,
      displayName: user.username ?? user.name ?? null,
      token: tokens.access_token,
      tokenMetadata: toMetadata(tokens, this.config),
      tokenExpiresAt: expiresAtFrom(tokens),
    };
  }

  async refreshToken(input: RefreshInput): Promise<RefreshResult> {
    const refreshTokenValue = readRefreshToken(input.tokenMetadata);
    if (!refreshTokenValue) {
      throw new LetmepostError({
        code: "platform_auth_failed",
        status: 401,
        platform: PLATFORM,
        message: "Cannot refresh Twitter token — no refresh token stored.",
        remediation:
          "Reconnect the account via POST /v1/accounts/connect/twitter.",
      });
    }
    const refreshArgs: Parameters<typeof refreshTwitterToken>[0] = {
      clientId: this.resolveClientId(),
      clientSecret: this.resolveClientSecret(),
      refreshToken: refreshTokenValue,
    };
    if (this.config.tokenUrl) refreshArgs.tokenUrl = this.config.tokenUrl;
    const tokens = await refreshTwitterToken(refreshArgs);
    return {
      token: tokens.access_token,
      tokenMetadata: toMetadata(
        tokens,
        this.config,
        input.tokenMetadata as TwitterTokenMetadata | null,
      ),
      tokenExpiresAt: expiresAtFrom(tokens),
    };
  }

  private resolveClientId(): string {
    return this.config.clientId ?? process.env.TWITTER_CLIENT_ID ?? "";
  }

  private resolveClientSecret(): string {
    return this.config.clientSecret ?? process.env.TWITTER_CLIENT_SECRET ?? "";
  }
}

export const twitterProvider = new TwitterProvider();
