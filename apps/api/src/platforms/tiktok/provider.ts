import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { LetmepostError } from "../../errors.js";
import { encodeOAuthState } from "../../oauth/state.js";
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
  exchangeTikTokCode,
  refreshTikTokToken,
  TIKTOK_API_BASE,
  TIKTOK_OAUTH_AUTHORIZE_URL,
  TikTokClient,
  type TikTokCreatorInfo,
  type TikTokPrivacyLevel,
  type TikTokTokenResponse,
} from "./client.js";

/**
 * TikTok provider — OAuth 2.0 + PKCE.
 *
 * What we persist after connect:
 *   - `token`         = TikTok access token (~24h lifetime).
 *   - `tokenMetadata` = `{ refreshToken, refreshTokenExpiresAt,
 *                          grantedScopes, openId, unionId, username,
 *                          auditState, creatorInfo }`.
 *   - `tokenExpiresAt` = now + expires_in seconds.
 *
 * Audit-state detection: the developer-portal `Sandbox` and `Audit`
 * profiles report `privacy_level_options: ["SELF_ONLY"]` from the
 * creator_info endpoint. The provider stores `auditState` so the
 * publisher can force SELF_ONLY without an upstream round-trip.
 *
 * Refresh: access tokens last 24h, so we wake the refresh worker 1h
 * before expiry — TikTok's clock skew tolerance is small, and we want
 * the next access token live before any scheduled-post worker wakes
 * up against the expiring one.
 */

const PLATFORM = "tiktok";
const EXPIRING_HORIZON_MS = 60 * 60 * 1000;

export type TikTokProviderConfig = {
  clientKey?: string;
  clientSecret?: string;
  /** Override the authorize URL for tests. */
  authorizeUrl?: string;
  /** Override the token URL for tests. */
  tokenUrl?: string;
  /** Override the API base — tests point at MSW. */
  apiBase?: string;
};

const CompleteConnectInput = z.object({
  code: z.string().min(1, "TikTok OAuth code is required."),
  state: z.string().min(1, "OAuth state is required."),
  redirectUri: z.string().url("redirectUri must be a URL."),
  codeVerifier: z.string().min(1, "PKCE codeVerifier is required for TikTok."),
});

export type TikTokAuditState = "audit" | "production";

export type TikTokTokenMetadata = {
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  grantedScopes?: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  /** Stable TikTok user id; cached so the publisher does not need to refetch. */
  openId?: string;
  unionId?: string;
  username?: string;
  /**
   * Snapshot of the privacy levels TikTok will accept on this account
   * today. Sandbox / audit accounts report `["SELF_ONLY"]`. Re-read on
   * every refresh so a flip from sandbox → production lands quickly.
   */
  privacyLevelOptions?: TikTokPrivacyLevel[];
  /**
   * Coarse summary of the privacy options — `audit` when only SELF_ONLY
   * is permitted, `production` otherwise. Stored alongside the raw
   * options so the dashboard / publisher can branch in one read.
   */
  auditState?: TikTokAuditState;
  /** Whole creator_info snapshot — kept for diagnostics + future toggles. */
  creatorInfo?: TikTokCreatorInfo;
};

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function computeRedirectUri(baseUrl: string): string {
  return new URL("/v1/accounts/oauth/tiktok/callback", baseUrl).toString();
}

function expiresAtFrom(resp: TikTokTokenResponse): Date {
  return new Date(Date.now() + resp.expires_in * 1000);
}

function refreshExpiresAtFrom(resp: TikTokTokenResponse): string | undefined {
  if (typeof resp.refresh_expires_in !== "number") return undefined;
  return new Date(
    Date.now() + resp.refresh_expires_in * 1000,
  ).toISOString();
}

/**
 * Coarse audit-state classification from the privacy allowlist. TikTok
 * reports SELF_ONLY-only for sandbox/audit apps. Production apps include
 * at least one non-SELF_ONLY option (public, mutual_follow, follower_of).
 */
export function classifyAuditState(
  info: TikTokCreatorInfo,
): TikTokAuditState {
  const opts = info.privacy_level_options ?? [];
  if (opts.length === 1 && opts[0] === "SELF_ONLY") return "audit";
  if (opts.length === 0) return "audit";
  return "production";
}

function readRefreshToken(
  tokenMetadata: Record<string, unknown> | null,
): string | null {
  if (!tokenMetadata) return null;
  const rt = (tokenMetadata as TikTokTokenMetadata).refreshToken;
  return typeof rt === "string" && rt.length > 0 ? rt : null;
}

function buildMetadata(
  resp: TikTokTokenResponse,
  config: TikTokProviderConfig,
  extras: Partial<TikTokTokenMetadata> = {},
): TikTokTokenMetadata {
  const md: TikTokTokenMetadata = {
    grantedScopes: resp.scope ? resp.scope.split(/[,\s]+/).filter(Boolean) : [],
    ...extras,
  };
  if (resp.refresh_token) md.refreshToken = resp.refresh_token;
  const refreshExp = refreshExpiresAtFrom(resp);
  if (refreshExp) md.refreshTokenExpiresAt = refreshExp;
  if (config.authorizeUrl) md.authorizeUrl = config.authorizeUrl;
  if (config.tokenUrl) md.tokenUrl = config.tokenUrl;
  return md;
}

export class TikTokProvider implements AccountProvider {
  readonly platform = PLATFORM;
  readonly expiringHorizonMs = EXPIRING_HORIZON_MS;

  constructor(private readonly config: TikTokProviderConfig = {}) {}

  describeConnect(ctx: ConnectContext): ConnectDescriptor {
    const scopes = [...scopeSetFor(PLATFORM).write];
    const codeVerifier = base64UrlEncode(randomBytes(32));
    const codeChallenge = base64UrlEncode(
      createHash("sha256").update(codeVerifier).digest(),
    );

    // Re-sign the state to embed the PKCE verifier — same shape as the
    // Twitter provider. The dashboard does a full-page redirect to
    // TikTok immediately and would otherwise drop the verifier.
    const state =
      ctx.oauthStatePayload != null
        ? encodeOAuthState({
            ...ctx.oauthStatePayload,
            pkce: { codeVerifier },
          })
        : (ctx.oauthState ?? randomUUID());

    const redirectUri = computeRedirectUri(ctx.baseUrl);
    const url = new URL(
      this.config.authorizeUrl ?? TIKTOK_OAUTH_AUTHORIZE_URL,
    );
    url.searchParams.set("response_type", "code");
    // TikTok uses `client_key` instead of `client_id`.
    url.searchParams.set("client_key", this.resolveClientKey());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(","));
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
        message: issue?.message ?? "Invalid TikTok connect payload.",
        rule: issue?.path.join(".") || "body",
        platformResponse: parsed.error.issues,
      });
    }
    const { code, codeVerifier, redirectUri } = parsed.data;
    const exchangeArgs: Parameters<typeof exchangeTikTokCode>[0] = {
      clientKey: this.resolveClientKey(),
      clientSecret: this.resolveClientSecret(),
      code,
      codeVerifier,
      redirectUri,
    };
    if (this.config.tokenUrl) exchangeArgs.tokenUrl = this.config.tokenUrl;
    const tokens = await exchangeTikTokCode(exchangeArgs);

    // Pin a real TikTok open_id as platformAccountId, and pull the
    // creator_info bag so the publisher can defend audit-state without
    // an extra round-trip. Both calls happen serially — TikTok's API
    // rate limits are loose here and the alternative (parallel + retry)
    // adds complexity for no real benefit.
    const apiBase = this.config.apiBase ?? TIKTOK_API_BASE;
    const client = new TikTokClient(tokens.access_token, apiBase);
    const user = await client.getUserInfo();

    // creator_info is the audit-state oracle. If it fails (e.g. the
    // account is missing video.upload scope after a partial grant) we
    // fall back to assuming `audit` rather than letting connect fail —
    // the publisher's defensive write-time check catches drift.
    let creatorInfo: TikTokCreatorInfo | undefined;
    let auditState: TikTokAuditState = "audit";
    try {
      creatorInfo = await client.queryCreatorInfo();
      auditState = classifyAuditState(creatorInfo);
    } catch {
      // Best-effort — explicit `audit` fallback is the safe default.
    }

    const extras: Partial<TikTokTokenMetadata> = {
      openId: user.open_id,
      auditState,
    };
    if (user.union_id !== undefined) extras.unionId = user.union_id;
    if (user.username !== undefined) extras.username = user.username;
    if (creatorInfo) {
      extras.creatorInfo = creatorInfo;
      extras.privacyLevelOptions = creatorInfo.privacy_level_options ?? [];
    }
    const metadata = buildMetadata(tokens, this.config, extras);

    return {
      platformAccountId: user.open_id,
      displayName: user.display_name ?? user.username ?? null,
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
        message: "Cannot refresh TikTok token — no refresh token stored.",
        remediation:
          "Reconnect the account via POST /v1/accounts/connect/tiktok.",
      });
    }
    const refreshArgs: Parameters<typeof refreshTikTokToken>[0] = {
      clientKey: this.resolveClientKey(),
      clientSecret: this.resolveClientSecret(),
      refreshToken: refreshTokenValue,
    };
    if (this.config.tokenUrl) refreshArgs.tokenUrl = this.config.tokenUrl;
    const tokens = await refreshTikTokToken(refreshArgs);

    // Carry forward cached open_id / unionId / username; TikTok's refresh
    // response does NOT re-emit them and the publisher relies on them.
    const prev = (input.tokenMetadata ?? {}) as TikTokTokenMetadata;
    const extras: Partial<TikTokTokenMetadata> = {};
    if (prev.openId !== undefined) extras.openId = prev.openId;
    if (prev.unionId !== undefined) extras.unionId = prev.unionId;
    if (prev.username !== undefined) extras.username = prev.username;

    // Best-effort: re-read creator_info so a flip from audit → production
    // lands without a manual reconnect. Failure leaves the prior snapshot
    // in place, which is safer than dropping it.
    try {
      const apiBase = this.config.apiBase ?? TIKTOK_API_BASE;
      const client = new TikTokClient(tokens.access_token, apiBase);
      const creatorInfo = await client.queryCreatorInfo();
      extras.creatorInfo = creatorInfo;
      extras.privacyLevelOptions = creatorInfo.privacy_level_options ?? [];
      extras.auditState = classifyAuditState(creatorInfo);
    } catch {
      if (prev.auditState !== undefined) extras.auditState = prev.auditState;
      if (prev.creatorInfo !== undefined) extras.creatorInfo = prev.creatorInfo;
      if (prev.privacyLevelOptions !== undefined) {
        extras.privacyLevelOptions = prev.privacyLevelOptions;
      }
    }

    return {
      token: tokens.access_token,
      tokenMetadata: buildMetadata(tokens, this.config, extras),
      tokenExpiresAt: expiresAtFrom(tokens),
    };
  }

  private resolveClientKey(): string {
    return this.config.clientKey ?? process.env.TIKTOK_CLIENT_KEY ?? "";
  }

  private resolveClientSecret(): string {
    return this.config.clientSecret ?? process.env.TIKTOK_CLIENT_SECRET ?? "";
  }
}

export const tiktokProvider = new TikTokProvider();
