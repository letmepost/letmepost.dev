import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LetmepostError } from "../../errors.js";
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
  exchangePinterestCode,
  PINTEREST_API_BASE,
  PINTEREST_OAUTH_AUTHORIZE_URL,
  PinterestClient,
  refreshPinterestToken,
  type PinterestTokenResponse,
} from "./client.js";

/**
 * Pinterest provider — classic OAuth 2.0 authorization-code flow (no PKCE).
 * Access tokens live 30 days; refresh tokens ~60 days. Refresh 7 days before
 * expiry per plan.md Phase 11 sizing.
 *
 * What we persist after connect:
 *   - `token`         = Pinterest access token (30-day bearer).
 *   - `tokenMetadata` = `{ refreshToken, refreshTokenExpiresAt, grantedScopes,
 *                         tokenUrl?, authorizeUrl? }`.
 *   - `tokenExpiresAt` = now + expires_in seconds from the token response.
 *
 * Client id / secret resolution: constructor overrides → env → empty string.
 * Empty-string defaults let tests with MSW run without real credentials;
 * production wiring fails fast at connect time because the upstream token
 * exchange will 401.
 */

const PLATFORM = "pinterest";
const EXPIRING_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export type PinterestProviderConfig = {
  clientId?: string;
  clientSecret?: string;
  /** Override the authorize URL for tests. */
  authorizeUrl?: string;
  /** Override the token URL for tests. */
  tokenUrl?: string;
  /** Override the API base — tests point at MSW. */
  apiBase?: string;
};

const CompleteConnectInput = z.object({
  code: z.string().min(1, "Pinterest OAuth code is required."),
  state: z.string().min(1, "OAuth state is required."),
  redirectUri: z.string().url("redirectUri must be a URL."),
});

export type PinterestTokenMetadata = {
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  grantedScopes?: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  /**
   * Default board the publisher pins to when the request body doesn't pass
   * `pinterest.boardId`. Seeded at connect-time from the user's first board;
   * the dashboard lets the user change it via PATCH /v1/accounts/:id.
   */
  defaultBoardId?: string;
  /** Friendly board name for the picker — kept in sync alongside the id. */
  defaultBoardName?: string;
};

function computeRedirectUri(baseUrl: string): string {
  // baseUrl may or may not have a trailing slash; URL handles both.
  return new URL("/v1/accounts/oauth/pinterest/callback", baseUrl).toString();
}

function expiresAtFrom(resp: PinterestTokenResponse): Date {
  return new Date(Date.now() + resp.expires_in * 1000);
}

function refreshExpiresAtFrom(resp: PinterestTokenResponse): string | undefined {
  if (typeof resp.refresh_token_expires_in !== "number") return undefined;
  return new Date(
    Date.now() + resp.refresh_token_expires_in * 1000,
  ).toISOString();
}

function toMetadata(
  resp: PinterestTokenResponse,
  config: PinterestProviderConfig,
): PinterestTokenMetadata {
  const md: PinterestTokenMetadata = {
    grantedScopes: resp.scope.split(/\s+/).filter(Boolean),
  };
  if (resp.refresh_token) md.refreshToken = resp.refresh_token;
  const refreshExp = refreshExpiresAtFrom(resp);
  if (refreshExp) md.refreshTokenExpiresAt = refreshExp;
  if (config.authorizeUrl) md.authorizeUrl = config.authorizeUrl;
  if (config.tokenUrl) md.tokenUrl = config.tokenUrl;
  return md;
}

function readRefreshToken(
  tokenMetadata: Record<string, unknown> | null,
): string | null {
  if (!tokenMetadata) return null;
  const rt = (tokenMetadata as PinterestTokenMetadata).refreshToken;
  return typeof rt === "string" && rt.length > 0 ? rt : null;
}

export class PinterestProvider implements AccountProvider {
  readonly platform = PLATFORM;
  readonly expiringHorizonMs = EXPIRING_HORIZON_MS;

  constructor(private readonly config: PinterestProviderConfig = {}) {}

  describeConnect(ctx: ConnectContext): ConnectDescriptor {
    const scopes = [...scopeSetFor(PLATFORM).write];
    const state = ctx.oauthState ?? randomUUID();
    const redirectUri = computeRedirectUri(ctx.baseUrl);
    const url = new URL(
      this.config.authorizeUrl ?? PINTEREST_OAUTH_AUTHORIZE_URL,
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.resolveClientId());
    url.searchParams.set("redirect_uri", redirectUri);
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
  ): Promise<ConnectedAccount> {
    const parsed = CompleteConnectInput.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: issue?.message ?? "Invalid Pinterest connect payload.",
        rule: issue?.path.join(".") || "body",
        platformResponse: parsed.error.issues,
      });
    }
    const { code, redirectUri } = parsed.data;
    const exchangeArgs: Parameters<typeof exchangePinterestCode>[0] = {
      clientId: this.resolveClientId(),
      clientSecret: this.resolveClientSecret(),
      code,
      redirectUri,
    };
    if (this.config.tokenUrl) exchangeArgs.tokenUrl = this.config.tokenUrl;
    const tokens = await exchangePinterestCode(exchangeArgs);

    // Pin a real Pinterest user as platformAccountId, and seed the default
    // board so the publisher has somewhere to pin without per-post overrides.
    // Both round-trips happen serially — Pinterest's rate limits are loose
    // here and the alternative (parallel + retry on partial failure) adds
    // complexity for no real benefit.
    const apiBase = this.config.apiBase ?? PINTEREST_API_BASE;
    const client = new PinterestClient(tokens.access_token, apiBase);
    const userAccount = await client.getUserAccount();
    const boards = await client.listBoards({ pageSize: 25 });

    const metadata = toMetadata(tokens, this.config);
    const firstBoard = boards[0];
    if (firstBoard) {
      metadata.defaultBoardId = firstBoard.id;
      metadata.defaultBoardName = firstBoard.name;
    }

    return {
      platformAccountId: userAccount.id,
      displayName: userAccount.username,
      token: tokens.access_token,
      tokenMetadata: metadata,
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
        message: "Cannot refresh Pinterest token — no refresh token stored.",
        remediation:
          "Reconnect the account via POST /v1/accounts/connect/pinterest.",
      });
    }
    const refreshArgs: Parameters<typeof refreshPinterestToken>[0] = {
      clientId: this.resolveClientId(),
      clientSecret: this.resolveClientSecret(),
      refreshToken: refreshTokenValue,
    };
    if (this.config.tokenUrl) refreshArgs.tokenUrl = this.config.tokenUrl;
    const tokens = await refreshPinterestToken(refreshArgs);
    // Merge fresh token fields over the persisted metadata rather than
    // replacing it: preserve defaultBoardId/defaultBoardName (and any other
    // non-token fields), and keep the existing refresh token when Pinterest's
    // response omits a new one (it doesn't always rotate it). `toMetadata`
    // only emits keys the response actually carried, so this spread never
    // clobbers a preserved field with undefined.
    const existing = (input.tokenMetadata ?? {}) as PinterestTokenMetadata;
    return {
      token: tokens.access_token,
      tokenMetadata: { ...existing, ...toMetadata(tokens, this.config) },
      tokenExpiresAt: expiresAtFrom(tokens),
    };
  }

  private resolveClientId(): string {
    return this.config.clientId ?? process.env.PINTEREST_CLIENT_ID ?? "";
  }

  private resolveClientSecret(): string {
    return (
      this.config.clientSecret ?? process.env.PINTEREST_CLIENT_SECRET ?? ""
    );
  }
}

export const pinterestProvider = new PinterestProvider();
