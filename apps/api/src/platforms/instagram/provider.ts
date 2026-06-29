import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LetmepostError } from "../../errors.js";
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

/**
 * Instagram API with Instagram Login — standalone OAuth (Meta 2024 product).
 *
 * Distinct from the Facebook Login for Business path in `meta/provider.ts`:
 *   - Users sign in with their Instagram account directly; no FB Page is required.
 *   - Works for Instagram Professional accounts (BUSINESS or MEDIA_CREATOR).
 *   - The access token is bound to the IG user, not a Page — publishing
 *     goes through `graph.instagram.com`, not `graph.facebook.com`.
 *
 * We mark rows from this provider with `tokenMetadata.kind = "ig-login"` so
 * the dispatcher routes the publisher to the right API host. Existing IG
 * rows from the FB-Login fan-out carry `kind: "instagram"` and continue
 * to hit `graph.facebook.com` with a Page token. Same row shape, different
 * upstream host.
 *
 * Token lifecycle:
 *   - Short-lived token from POST /oauth/access_token (1h)
 *   - Swap for long-lived (60d) via GET /access_token?grant_type=ig_exchange_token
 *   - Refresh via GET /refresh_access_token?grant_type=ig_refresh_token
 */

const PLATFORM = "instagram";
const EXPIRING_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

const INSTAGRAM_OAUTH_AUTHORIZE_URL =
  process.env.INSTAGRAM_OAUTH_AUTHORIZE_URL ??
  "https://www.instagram.com/oauth/authorize";
const INSTAGRAM_OAUTH_TOKEN_URL =
  process.env.INSTAGRAM_OAUTH_TOKEN_URL ??
  "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_GRAPH_BASE =
  process.env.INSTAGRAM_GRAPH_BASE ?? "https://graph.instagram.com";

export type InstagramAccountMetadataIgLogin = {
  /** Discriminant — `ig-login` distinguishes from FB-fanout `instagram` rows. */
  kind: "ig-login";
  /** IG username — surfaced as displayName, persisted for refresh recovery. */
  username?: string;
  /** Reported by Meta; we don't act on it but log it in case access scopes diverge. */
  accountType?: string;
  /** Comma-joined string of granted permissions (Meta echoes back what user actually granted). */
  grantedScopes?: string;
  /** App-scoped connecting-user id; matched by the deauth/data-deletion callbacks. */
  metaUserId?: string;
};

export type InstagramProviderConfig = {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  graphBase?: string;
};

const CompleteConnectInput = z.object({
  code: z.string().min(1, "Instagram OAuth code is required."),
  state: z.string().min(1, "OAuth state is required."),
  redirectUri: z.string().url("redirectUri must be a URL."),
});

function computeRedirectUri(baseUrl: string): string {
  return new URL("/v1/accounts/oauth/instagram/callback", baseUrl).toString();
}

export class InstagramProvider implements AccountProvider {
  readonly platform = PLATFORM;
  readonly expiringHorizonMs = EXPIRING_HORIZON_MS;

  constructor(private readonly config: InstagramProviderConfig = {}) {}

  describeConnect(ctx: ConnectContext): ConnectDescriptor {
    const scopes = [...scopeSetFor(PLATFORM).write];
    const state = ctx.oauthState ?? randomUUID();
    const redirectUri = computeRedirectUri(ctx.baseUrl);
    const url = new URL(
      this.config.authorizeUrl ?? INSTAGRAM_OAUTH_AUTHORIZE_URL,
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.resolveClientId());
    url.searchParams.set("redirect_uri", redirectUri);
    // IG Login expects scopes as a comma-separated string.
    url.searchParams.set("scope", scopes.join(","));
    url.searchParams.set("state", state);
    return {
      kind: "oauth",
      authorizationUrl: url.toString(),
      state,
      scopes,
      redirectUri,
    };
  }

  async completeConnect(
    _ctx: ConnectContext,
    raw: unknown,
  ): Promise<ConnectedAccount[]> {
    const parsed = CompleteConnectInput.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: issue?.message ?? "Invalid Instagram connect payload.",
        rule: issue?.path.join(".") || "body",
        platformResponse: parsed.error.issues,
      });
    }
    const { code, redirectUri } = parsed.data;

    // 1. Exchange code → short-lived token + user_id.
    const tokenRes = await platformFetch<{
      access_token?: string;
      user_id?: number | string;
      permissions?: string;
    }>({
      method: "POST",
      url: this.config.tokenUrl ?? INSTAGRAM_OAUTH_TOKEN_URL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.resolveClientId(),
        client_secret: this.resolveClientSecret(),
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }).toString(),
      platform: PLATFORM,
    });
    if (!tokenRes.ok || !tokenRes.body?.access_token || !tokenRes.body.user_id) {
      throw new LetmepostError({
        code: "platform_auth_failed",
        status: 502,
        platform: PLATFORM,
        message: "Instagram code exchange failed.",
        rule: "instagram.oauth.code_exchange",
        platformResponse: tokenRes.body,
        remediation:
          "Verify INSTAGRAM_CLIENT_ID / INSTAGRAM_CLIENT_SECRET match the Meta app and that the user's Instagram account is a Professional account (Business or Creator).",
      });
    }

    const shortLived = tokenRes.body.access_token;
    const grantedScopes = tokenRes.body.permissions;
    const appScopedUserId = tokenRes.body.user_id;

    // 2. Swap short-lived (1h) → long-lived (60d).
    const longUrl = new URL(
      `${this.config.graphBase ?? INSTAGRAM_GRAPH_BASE}/access_token`,
    );
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", this.resolveClientSecret());
    longUrl.searchParams.set("access_token", shortLived);
    const longRes = await platformFetch<{
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    }>({
      method: "GET",
      url: longUrl.toString(),
      platform: PLATFORM,
    });
    if (!longRes.ok || !longRes.body?.access_token) {
      throw new LetmepostError({
        code: "platform_auth_failed",
        status: 502,
        platform: PLATFORM,
        message: "Instagram long-lived token exchange failed.",
        rule: "instagram.oauth.long_lived_exchange",
        platformResponse: longRes.body,
      });
    }

    const longToken = longRes.body.access_token;
    const expiresIn = longRes.body.expires_in ?? 60 * 24 * 60 * 60; // ~60d fallback
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    // 3. Resolve identity via /me. The Content Publishing API expects `id`
    //    (the IG-scoped user id) in `/{ig-user-id}/media`, NOT the
    //    `user_id` returned by the token exchange — those are different
    //    numbers for the same account, and sending user_id returns code:2.
    const meUrl = new URL(
      `${this.config.graphBase ?? INSTAGRAM_GRAPH_BASE}/me`,
    );
    meUrl.searchParams.set("fields", "id,user_id,username,account_type");
    meUrl.searchParams.set("access_token", longToken);
    const meRes = await platformFetch<{
      id?: string;
      user_id?: string;
      username?: string;
      account_type?: string;
    }>({
      method: "GET",
      url: meUrl.toString(),
      platform: PLATFORM,
    });
    if (!meRes.ok || !meRes.body?.id) {
      throw new LetmepostError({
        code: "platform_auth_failed",
        status: 502,
        platform: PLATFORM,
        message: "Instagram /me lookup failed after token exchange.",
        rule: "instagram.oauth.me_lookup",
        platformResponse: meRes.body,
      });
    }
    const igScopedUserId = meRes.body.id;
    const username = meRes.body?.username;
    const accountType = meRes.body?.account_type;

    if (accountType === "PERSONAL") {
      throw new LetmepostError({
        code: "platform_rejected",
        status: 400,
        platform: PLATFORM,
        message:
          "Instagram Personal accounts can't publish via the Content Publishing API. Switch to a Business or Creator account to continue.",
        rule: "instagram.account_type.requires_professional",
        platformResponse: { accountType: accountType ?? null, username },
        remediation:
          "On Instagram: open the app → Profile → menu (≡) → Settings and privacy → Account type and tools → Switch to professional account. The change is instant. Then try Connect again.",
      });
    }

    const metadata: InstagramAccountMetadataIgLogin = { kind: "ig-login" };
    if (username) metadata.username = username;
    if (accountType) metadata.accountType = accountType;
    if (grantedScopes) metadata.grantedScopes = grantedScopes;
    if (appScopedUserId !== undefined && appScopedUserId !== null) {
      metadata.metaUserId = String(appScopedUserId);
    }

    return [
      {
        platform: PLATFORM,
        platformAccountId: igScopedUserId,
        displayName: username ?? null,
        token: longToken,
        tokenMetadata: metadata as unknown as Record<string, unknown>,
        tokenExpiresAt,
      },
    ];
  }

  async refreshToken(input: RefreshInput): Promise<RefreshResult> {
    // IG long-lived tokens can be refreshed once they're at least 24h old.
    // GET /refresh_access_token?grant_type=ig_refresh_token&access_token=<token>
    const url = new URL(
      `${this.config.graphBase ?? INSTAGRAM_GRAPH_BASE}/refresh_access_token`,
    );
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", input.token);
    const res = await platformFetch<{
      access_token?: string;
      expires_in?: number;
    }>({
      method: "GET",
      url: url.toString(),
      platform: PLATFORM,
    });
    if (!res.ok || !res.body?.access_token) {
      throw new LetmepostError({
        code: "platform_auth_failed",
        status: 502,
        platform: PLATFORM,
        message: "Instagram token refresh failed.",
        rule: "instagram.oauth.refresh",
        platformResponse: res.body,
        remediation:
          "User may need to reconnect via the Instagram OAuth flow if the token was revoked.",
      });
    }
    const expiresIn = res.body.expires_in ?? 60 * 24 * 60 * 60;
    return {
      token: res.body.access_token,
      tokenMetadata: input.tokenMetadata,
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  private resolveClientId(): string {
    return this.config.clientId ?? process.env.INSTAGRAM_CLIENT_ID ?? "";
  }

  private resolveClientSecret(): string {
    return this.config.clientSecret ?? process.env.INSTAGRAM_CLIENT_SECRET ?? "";
  }
}

export const instagramProvider = new InstagramProvider();
