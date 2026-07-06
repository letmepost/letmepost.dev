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
  exchangeFacebookCode,
  exchangeFacebookForLongLived,
  META_GRAPH_BASE,
  META_GRAPH_VERSION,
  META_OAUTH_AUTHORIZE_URL,
  MetaDiscoveryClient,
  type MetaPageAccount,
} from "./client.js";

/**
 * Meta provider — Facebook Pages only. Registered under the `"facebook"`
 * platform key; one OAuth grant produces one row per Page the user
 * administers.
 *
 * Instagram is intentionally NOT part of this provider's output anymore.
 * IG has its own dedicated OAuth (`platforms/instagram/provider.ts`) so:
 *   - One tile in the dashboard = one platform (clearer UX).
 *   - FB Login App Review surface is just Pages scopes, not bundled with IG.
 *   - Users without an FB Page can still connect IG (they couldn't via fan-out).
 *
 * What we persist after connect — one row per Page:
 *   - `platformAccountId` = Page id
 *   - `displayName`       = Page name
 *   - `token`             = Page Access Token (NON-EXPIRING with FBLB)
 *   - `tokenMetadata`     = `{ kind: "page", pageTasks?, metaUserId }`
 *
 * Refresh: Page Access Tokens derived from a long-lived User token are
 * non-expiring (Meta's documented contract). The refreshToken
 * implementation is therefore a no-op that re-uses the stored token.
 * If the user revokes via Settings → Apps, the next API call surfaces
 * `platform_auth_failed` and the dashboard prompts re-connect.
 */

const PLATFORM = "facebook";
/** Long-lived user token expires in 60d, but Page tokens are non-expiring. */
const EXPIRING_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export type MetaProviderConfig = {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  graphBase?: string;
  graphVersion?: string;
};

const CompleteConnectInput = z.object({
  code: z.string().min(1, "Meta OAuth code is required."),
  state: z.string().min(1, "OAuth state is required."),
  redirectUri: z.string().url("redirectUri must be a URL."),
});

export type FacebookPageMetadata = {
  kind: "page";
  /** Tasks the user has been granted on this Page (e.g. CREATE_CONTENT). */
  pageTasks?: string[];
  /**
   * App-scoped user id of the connecting Facebook user (`GET /me`). This is
   * the value Meta sends in the data-deletion / deauth signed_request's
   * `user_id` field — NOT the Page id we store as platformAccountId — so it's
   * what those callbacks match on to remove this row.
   */
  metaUserId?: string;
};

/**
 * Legacy IG metadata shape — kept exported (deprecated) because pre-existing
 * IG rows created by the FB-fanout path may still carry it. New IG rows
 * come from `instagram/provider.ts` and use a different shape
 * (`tokenMetadata.kind = "ig-login"`).
 *
 * @deprecated The FB-fanout no longer creates IG rows. Existing rows
 *   keep working through dispatch's `tokenMetadata.kind` switch.
 */
export type InstagramAccountMetadata = {
  kind: "instagram";
  pageId: string;
  pageAccountId?: string;
};

function computeRedirectUri(baseUrl: string): string {
  return new URL("/v1/accounts/oauth/facebook/callback", baseUrl).toString();
}

function expiresAtFrom(expiresInSeconds: number | undefined): Date | null {
  if (!expiresInSeconds || expiresInSeconds <= 0) return null;
  return new Date(Date.now() + expiresInSeconds * 1000);
}

/**
 * Build the ConnectedAccount record for a single Page. Returns one row.
 * IG fan-out was removed when IG got its own OAuth — see the file
 * header docstring for why.
 */
function buildPageRecord(
  page: MetaPageAccount,
  metaUserId: string,
): ConnectedAccount {
  const fbMeta: FacebookPageMetadata = { kind: "page", metaUserId };
  if (page.tasks) fbMeta.pageTasks = page.tasks;

  return {
    platform: "facebook",
    platformAccountId: page.id,
    displayName: page.name,
    token: page.access_token,
    tokenMetadata: fbMeta as unknown as Record<string, unknown>,
    // Page tokens are non-expiring; null tells the refresh scheduler
    // "never re-refresh from the clock" — event-driven only.
    tokenExpiresAt: null,
  };
}

export class MetaProvider implements AccountProvider {
  readonly platform = PLATFORM;
  readonly expiringHorizonMs = EXPIRING_HORIZON_MS;

  constructor(private readonly config: MetaProviderConfig = {}) {}

  describeConnect(ctx: ConnectContext): ConnectDescriptor {
    const scopes = [...scopeSetFor(PLATFORM).write];
    const state = ctx.oauthState ?? randomUUID();
    const redirectUri = computeRedirectUri(ctx.baseUrl);
    const url = new URL(
      this.config.authorizeUrl ?? META_OAUTH_AUTHORIZE_URL,
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.resolveClientId());
    url.searchParams.set("redirect_uri", redirectUri);
    // Meta accepts comma-separated scopes.
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
        message: issue?.message ?? "Invalid Meta connect payload.",
        rule: issue?.path.join(".") || "body",
        platformResponse: parsed.error.issues,
      });
    }
    const { code, redirectUri } = parsed.data;

    const exchangeArgs: Parameters<typeof exchangeFacebookCode>[0] = {
      clientId: this.resolveClientId(),
      clientSecret: this.resolveClientSecret(),
      code,
      redirectUri,
    };
    if (this.config.tokenUrl) exchangeArgs.tokenUrl = this.config.tokenUrl;
    const short = await exchangeFacebookCode(exchangeArgs);

    // Swap to long-lived. Page tokens derived from this are non-expiring,
    // so we want the long path even though we discard the User token
    // after `listPages`.
    const longArgs: Parameters<typeof exchangeFacebookForLongLived>[0] = {
      clientId: this.resolveClientId(),
      clientSecret: this.resolveClientSecret(),
      shortLivedToken: short.access_token,
    };
    if (this.config.tokenUrl) longArgs.tokenUrl = this.config.tokenUrl;
    const long = await exchangeFacebookForLongLived(longArgs);
    void expiresAtFrom; // long.expires_in is informational; Page tokens don't inherit it

    const graphBase = this.config.graphBase ?? META_GRAPH_BASE;
    const version = this.config.graphVersion ?? META_GRAPH_VERSION;
    const client = new MetaDiscoveryClient(long.access_token, graphBase, version);

    // App-scoped user id of the connecting user — persisted on every Page
    // row so the data-deletion / deauth callbacks can find and remove this
    // user's accounts (they key off signed_request.user_id, which equals
    // this id, not the Page id we store as platformAccountId).
    const me = await client.getMe();

    const pages = await client.listPages();
    if (pages.length === 0) {
      throw new LetmepostError({
        code: "platform_rejected",
        status: 400,
        platform: PLATFORM,
        message:
          "The connected user manages no Facebook Pages — letmepost has nothing to publish to.",
        rule: "facebook.pages.none",
        remediation:
          "Connect a user who administers at least one Facebook Page (Pages > Settings > New Roles, or transfer ownership). Personal-feed posting is not part of the v1 scope. To publish to Instagram, use the Instagram tile instead — IG has its own OAuth flow.",
      });
    }

    return pages.map((page) => buildPageRecord(page, me.id));
  }

  async refreshToken(input: RefreshInput): Promise<RefreshResult> {
    // Page tokens derived from a long-lived User token are non-expiring.
    // The scheduler may still call this if `tokenExpiresAt` was set
    // (e.g. legacy rows from a prior provider implementation) — return
    // the existing token unchanged. If Meta has actually revoked, the
    // next API call surfaces 190/102 and the dashboard nudges
    // re-connect; the refresh path doesn't try to "fix" that itself
    // because we have no User token in hand here.
    return {
      token: input.token,
      tokenMetadata: input.tokenMetadata,
      tokenExpiresAt: null,
    };
  }

  private resolveClientId(): string {
    return this.config.clientId ?? process.env.META_APP_ID ?? "";
  }

  private resolveClientSecret(): string {
    return this.config.clientSecret ?? process.env.META_APP_SECRET ?? "";
  }
}

export const metaProvider = new MetaProvider();
