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
  exchangeForLongLivedToken,
  exchangeThreadsCode,
  refreshLongLivedToken,
  THREADS_API_BASE,
  THREADS_API_VERSION,
  THREADS_OAUTH_AUTHORIZE_URL,
  ThreadsClient,
  type ThreadsLongLivedToken,
} from "./client.js";

/**
 * Threads provider — standalone OAuth at threads.net (NOT Facebook Login
 * for Business). The flow is:
 *
 *   1. /v1/accounts/connect/threads → describeConnect builds the
 *      authorize URL pointing at https://threads.net/oauth/authorize
 *      with the v1 scopes (`threads_basic`, `threads_content_publish`).
 *   2. The user grants → Threads redirects to our callback with `code`.
 *   3. completeConnect exchanges the code for a SHORT-lived token (1h),
 *      then immediately swaps it for a LONG-lived token (60d). Only the
 *      long-lived token is persisted.
 *   4. We hit `GET /me` to pin the platform_account_id to the real
 *      Threads user id — same pattern as Pinterest's `getUserAccount`.
 *
 * What we persist after connect:
 *   - `token`         = long-lived 60-day access token.
 *   - `tokenMetadata` = `{ userId, metaUserId, grantedScopes, refreshable: true,
 *                          authorizeUrl?, apiBase? }`.
 *   - `tokenExpiresAt` = now + expires_in (typically 60d).
 *
 * Refresh: GET /refresh_access_token any time after the first 24 hours
 * and before the 60-day expiry. The scheduler fires 7 days before expiry
 * (matches LinkedIn / Pinterest) and emits `token.expiring` if it fails.
 */

const PLATFORM = "threads";
const EXPIRING_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export type ThreadsProviderConfig = {
  clientId?: string;
  clientSecret?: string;
  /** Override the authorize URL for tests. */
  authorizeUrl?: string;
  /** Override the token URL (short-lived exchange) for tests. */
  tokenUrl?: string;
  /** Override the long-lived swap URL for tests. */
  longLivedTokenUrl?: string;
  /** Override the refresh URL for tests. */
  refreshTokenUrl?: string;
  /** Override the Graph API base — tests point at MSW. */
  apiBase?: string;
  /** Override the Graph API version (default v1.0). */
  apiVersion?: string;
};

const CompleteConnectInput = z.object({
  code: z.string().min(1, "Threads OAuth code is required."),
  state: z.string().min(1, "OAuth state is required."),
  redirectUri: z.string().url("redirectUri must be a URL."),
});

export type ThreadsTokenMetadata = {
  /** Threads user id — same value pinned as platformAccountId; cached for refresh. */
  userId?: string;
  /**
   * App-scoped user id Meta's data-deletion / deauth signed_request carries.
   * For Threads this equals the Threads user id, but those callbacks match on
   * tokenMetadata.metaUserId uniformly across the Meta family, so it's stored
   * explicitly here (and carried through refresh).
   */
  metaUserId?: string;
  grantedScopes?: string[];
  /** Always true post-Phase-8; flag exists so legacy rows can opt out. */
  refreshable?: boolean;
  /** Echoed for tests / future re-authorize flows; never required. */
  authorizeUrl?: string;
  apiBase?: string;
};

function computeRedirectUri(baseUrl: string): string {
  return new URL("/v1/accounts/oauth/threads/callback", baseUrl).toString();
}

function expiresAtFrom(resp: ThreadsLongLivedToken): Date {
  return new Date(Date.now() + resp.expires_in * 1000);
}

function readUserId(
  tokenMetadata: Record<string, unknown> | null,
): string | null {
  if (!tokenMetadata) return null;
  const md = tokenMetadata as ThreadsTokenMetadata;
  return typeof md.userId === "string" && md.userId.length > 0
    ? md.userId
    : null;
}

export class ThreadsProvider implements AccountProvider {
  readonly platform = PLATFORM;
  readonly expiringHorizonMs = EXPIRING_HORIZON_MS;

  constructor(private readonly config: ThreadsProviderConfig = {}) {}

  describeConnect(ctx: ConnectContext): ConnectDescriptor {
    const scopes = [...scopeSetFor(PLATFORM).write];
    const state = ctx.oauthState ?? randomUUID();
    const redirectUri = computeRedirectUri(ctx.baseUrl);
    const url = new URL(
      this.config.authorizeUrl ?? THREADS_OAUTH_AUTHORIZE_URL,
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.resolveClientId());
    url.searchParams.set("redirect_uri", redirectUri);
    // Threads expects scopes comma-separated, matching the Pinterest pattern.
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
        message: issue?.message ?? "Invalid Threads connect payload.",
        rule: issue?.path.join(".") || "body",
        platformResponse: parsed.error.issues,
      });
    }
    const { code, redirectUri } = parsed.data;

    const exchangeArgs: Parameters<typeof exchangeThreadsCode>[0] = {
      clientId: this.resolveClientId(),
      clientSecret: this.resolveClientSecret(),
      code,
      redirectUri,
    };
    if (this.config.tokenUrl) exchangeArgs.tokenUrl = this.config.tokenUrl;
    const short = await exchangeThreadsCode(exchangeArgs);

    // Always swap short → long-lived. Persisting the short-lived token
    // would have us re-running OAuth in 1 hour, which is the opposite of
    // what users expect when they "connect" an account.
    const longArgs: Parameters<typeof exchangeForLongLivedToken>[0] = {
      clientSecret: this.resolveClientSecret(),
      shortLivedToken: short.access_token,
    };
    if (this.config.longLivedTokenUrl) {
      longArgs.baseUrl = this.config.longLivedTokenUrl;
    }
    const long = await exchangeForLongLivedToken(longArgs);

    // Pin platformAccountId to the real Threads user id, and pull the
    // username for displayName. `short.user_id` already gives us the id,
    // but `GET /me` also gives us the @-handle — worth the round-trip
    // because the dashboard renders that string and we don't want
    // "thread_user_8675309" instead of @rosekamallove.
    const apiBase = this.config.apiBase ?? THREADS_API_BASE;
    const apiVersion = this.config.apiVersion ?? THREADS_API_VERSION;
    const client = new ThreadsClient(long.access_token, apiBase, apiVersion);
    const me = await client.getMe();

    const metadata: ThreadsTokenMetadata = {
      userId: me.id,
      metaUserId: me.id,
      grantedScopes: [...scopeSetFor(PLATFORM).write],
      refreshable: true,
    };
    if (this.config.authorizeUrl) metadata.authorizeUrl = this.config.authorizeUrl;
    if (this.config.apiBase) metadata.apiBase = this.config.apiBase;

    return {
      platformAccountId: me.id,
      displayName: me.username ?? me.name ?? null,
      token: long.access_token,
      tokenMetadata: metadata,
      tokenExpiresAt: expiresAtFrom(long),
    };
  }

  async refreshToken(input: RefreshInput): Promise<RefreshResult> {
    const refreshArgs: Parameters<typeof refreshLongLivedToken>[0] = {
      longLivedToken: input.token,
    };
    if (this.config.refreshTokenUrl) {
      refreshArgs.baseUrl = this.config.refreshTokenUrl;
    }
    const refreshed = await refreshLongLivedToken(refreshArgs);

    // Carry forward the cached userId — the refresh endpoint doesn't
    // re-emit it, and the publisher needs it on every call.
    const cachedUserId = readUserId(input.tokenMetadata);
    const metadata: ThreadsTokenMetadata = {
      grantedScopes:
        (input.tokenMetadata as ThreadsTokenMetadata | null)?.grantedScopes ??
        [...scopeSetFor(PLATFORM).write],
      refreshable: true,
    };
    if (cachedUserId) {
      metadata.userId = cachedUserId;
      metadata.metaUserId = cachedUserId;
    }
    if (this.config.authorizeUrl) metadata.authorizeUrl = this.config.authorizeUrl;
    if (this.config.apiBase) metadata.apiBase = this.config.apiBase;

    return {
      token: refreshed.access_token,
      tokenMetadata: metadata,
      tokenExpiresAt: expiresAtFrom(refreshed),
    };
  }

  private resolveClientId(): string {
    return this.config.clientId ?? process.env.THREADS_CLIENT_ID ?? "";
  }

  private resolveClientSecret(): string {
    return (
      this.config.clientSecret ?? process.env.THREADS_CLIENT_SECRET ?? ""
    );
  }
}

export const threadsProvider = new ThreadsProvider();
