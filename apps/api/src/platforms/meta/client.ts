import { platformFetch } from "../_shared/http.js";
import {
  authFailed,
  extractUpstreamMessage,
  rateLimited,
  rejected,
} from "../_shared/errors.js";
import { LetmepostError } from "../../errors.js";

/**
 * Meta Graph API hosts. The base is `graph.facebook.com`; we pin a version
 * via `META_GRAPH_VERSION` so an upstream version cut is a single env var
 * change + contract test re-run, not a code-wide bump. Default tracks
 * Meta's current "latest stable" — re-evaluate per quarterly cycle.
 *
 * NOTE: this client is shared by both `facebook` and `instagram` letmepost
 * platforms because Meta's API surface is unified — the same Graph host,
 * the same User Access Token / Page Access Token model, the same error
 * envelope. The split between `facebook` and `instagram` happens at the
 * publisher / preflight layer, not here.
 */
export const META_GRAPH_BASE =
  process.env.META_GRAPH_BASE ?? "https://graph.facebook.com";
export const META_GRAPH_VERSION =
  process.env.META_GRAPH_VERSION ?? "v23.0";
export const META_OAUTH_AUTHORIZE_URL =
  process.env.META_OAUTH_AUTHORIZE_URL ??
  `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
/** Both short→long token swap and code exchange use the same endpoint. */
export const META_OAUTH_TOKEN_URL = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}/oauth/access_token`;

/** Used for both FB Page errors and IG-side errors. */
export interface MetaErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
    type?: string;
    fbtrace_id?: string;
    error_user_msg?: string;
    error_user_title?: string;
  };
}

const PLATFORM_FACEBOOK = "facebook";

/* ─────────────────────────────────────────────────────────────────────────
 * OAuth + discovery
 * ───────────────────────────────────────────────────────────────────────── */

export interface MetaTokenResponse {
  access_token: string;
  token_type?: string;
  /** Long-lived User Tokens carry expires_in (~60 days); short-lived ones don't. */
  expires_in?: number;
}

export interface MetaMe {
  id: string;
  name?: string;
}

/**
 * Each item in `GET /me/accounts`. The `access_token` here is a Page
 * Access Token — non-expiring as long as the user's User Token stays
 * valid AND the user hasn't revoked the grant. Persist this; it's what
 * we use for every subsequent FB Page write.
 */
export interface MetaPageAccount {
  id: string;
  name: string;
  access_token: string;
  /** Subset of permission tasks granted on this Page. */
  tasks?: string[];
  /** Set on Pages that have an IG Business account linked. */
  instagram_business_account?: { id: string };
}

/** `GET /me/accounts?fields=...` response wrapper. */
interface MetaPagesResponse {
  data: MetaPageAccount[];
  paging?: { next?: string };
}

/** `GET /{ig-id}?fields=username,...` — used to seed displayName on IG rows. */
export interface MetaIgUser {
  id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
}

/**
 * Exchange the OAuth `code` for a SHORT-lived User Access Token.
 * Caller normally swaps this immediately for a long-lived one — short
 * tokens are fine if the only operation is `GET /me/accounts` (which we
 * do at connect time) but the *Page* tokens we'll persist are derived
 * from the long-lived path.
 */
export async function exchangeFacebookCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<MetaTokenResponse> {
  const url = new URL(params.tokenUrl ?? META_OAUTH_TOKEN_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("client_secret", params.clientSecret);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code", params.code);

  const res = await platformFetch<MetaTokenResponse>({
    method: "GET",
    url: url.toString(),
    platform: PLATFORM_FACEBOOK,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM_FACEBOOK,
      platformResponse: res.body ?? res.raw ?? undefined,
      remediation:
        "Verify the Meta app id / secret and that the redirect URI matches the FBLB app registration exactly.",
    });
  }
  return res.body;
}

/**
 * Swap a short-lived User Access Token for a 60-day long-lived one.
 * Page tokens derived from a long-lived User token are themselves
 * non-expiring — that's why we always go through this swap on connect.
 */
export async function exchangeFacebookForLongLived(params: {
  clientId: string;
  clientSecret: string;
  shortLivedToken: string;
  tokenUrl?: string;
}): Promise<MetaTokenResponse> {
  const url = new URL(params.tokenUrl ?? META_OAUTH_TOKEN_URL);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("client_secret", params.clientSecret);
  url.searchParams.set("fb_exchange_token", params.shortLivedToken);

  const res = await platformFetch<MetaTokenResponse>({
    method: "GET",
    url: url.toString(),
    platform: PLATFORM_FACEBOOK,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM_FACEBOOK,
      platformResponse: res.body ?? res.raw ?? undefined,
      remediation:
        "Meta rejected the short→long token swap. Most common cause is a mismatched client secret.",
    });
  }
  return res.body;
}

/**
 * Discovery client. Same instance is used at connect time across the
 * fan-out — the User Access Token here is short-lived discovery only; the
 * publisher uses Page tokens persisted on each row.
 */
export class MetaDiscoveryClient {
  constructor(
    private readonly accessToken: string,
    private readonly graphBase: string = META_GRAPH_BASE,
    private readonly version: string = META_GRAPH_VERSION,
  ) {}

  private url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(`${this.graphBase}/${this.version}${path}`);
    u.searchParams.set("access_token", this.accessToken);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** `GET /me?fields=id,name` — sanity-check the token. */
  async getMe(): Promise<MetaMe> {
    const res = await platformFetch<MetaMe>({
      method: "GET",
      url: this.url("/me", { fields: "id,name" }),
      platform: PLATFORM_FACEBOOK,
    });
    if (!res.ok || !res.body?.id) {
      throw mapMetaError(res, {
        fallbackRemediation:
          "The Meta access token is invalid; re-run the FBLB connect flow.",
      });
    }
    return res.body;
  }

  /**
   * `GET /me/accounts?fields=id,name,access_token,tasks,instagram_business_account`
   * Returns every Page the connecting user manages, with that Page's
   * non-expiring access token + its linked IG Business account id (if
   * any). Single page of results — Meta defaults to limit=25, which
   * covers >99% of agencies; bumps to 100 below for headroom.
   */
  async listPages(): Promise<MetaPageAccount[]> {
    const res = await platformFetch<MetaPagesResponse>({
      method: "GET",
      url: this.url("/me/accounts", {
        fields: "id,name,access_token,tasks,instagram_business_account",
        limit: "100",
      }),
      platform: PLATFORM_FACEBOOK,
    });
    if (!res.ok || !res.body) {
      throw mapMetaError(res, {
        fallbackRemediation:
          "Meta /me/accounts call failed. Confirm the user has at least one Page they administer.",
      });
    }
    return res.body.data ?? [];
  }

  /**
   * `GET /{ig-id}?fields=id,username,name,profile_picture_url` — fetch
   * the IG @-handle so the dashboard renders something useful instead of
   * the raw numeric id.
   */
  async getInstagramUser(igId: string): Promise<MetaIgUser> {
    const res = await platformFetch<MetaIgUser>({
      method: "GET",
      url: this.url(`/${encodeURIComponent(igId)}`, {
        fields: "id,username,name,profile_picture_url",
      }),
      platform: PLATFORM_FACEBOOK,
    });
    if (!res.ok || !res.body?.id) {
      // Fall back to id-only — losing the username isn't fatal at connect
      // time. The publisher doesn't need it.
      return { id: igId };
    }
    return res.body;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Shared error mapping
 *
 * Meta's Graph API surfaces errors in a consistent envelope. We map the
 * common codes once here and let each publisher re-use the function.
 *
 * Critical mappings for the corpus:
 *   - 190        → expired/invalid token (user revoked, token expired)
 *   - 200 / 10   → permission/scope mismatch
 *   - 4 / 17 / 32 / 613 → rate limited (app or user level)
 *   - 100        → invalid parameter — most "bad URL" / "bad media" land here
 *   - 2207052    → IG: media URL is not publicly accessible
 *   - 2207003    → IG: image aspect ratio out of range
 *   - 2207020    → IG/Threads: container expired (24h)
 *   - 1          → unknown / transient — surface as platform_unavailable
 * ───────────────────────────────────────────────────────────────────────── */

export function mapMetaError(
  res: { body: unknown; status: number; raw: string | null },
  opts: { fallbackRemediation?: string; platform?: string } = {},
): LetmepostError {
  const platform = opts.platform ?? PLATFORM_FACEBOOK;
  const meta = res.body as MetaErrorBody | undefined;
  const code = meta?.error?.code;
  const subcode = meta?.error?.error_subcode;
  const upstreamMessage =
    meta?.error?.error_user_msg ??
    meta?.error?.message ??
    extractUpstreamMessage(res.body);
  const lowerMsg = (upstreamMessage ?? "").toLowerCase();

  if (res.status === 401 || code === 190 || code === 102) {
    return authFailed({
      platform,
      platformResponse: res.body ?? res.raw ?? undefined,
      remediation:
        "The Meta access token is invalid, expired, or the user revoked the grant. Re-connect via the FBLB flow.",
    });
  }

  if (code === 10 || code === 200 || code === 299) {
    return authFailed({
      platform,
      platformResponse: res.body ?? res.raw ?? undefined,
      remediation:
        "Meta rejected the call for missing permission. Reconnect the account so the app re-requests the required scopes (the Page may have been transferred to a Business Manager that hasn't re-granted access).",
    });
  }

  if (
    res.status === 429 ||
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613
  ) {
    return rateLimited({
      platform,
      platformResponse: res.body ?? res.raw ?? undefined,
      upstreamMessage: upstreamMessage ?? "Rate limited by Meta.",
      remediation:
        "Back off and retry. Meta enforces both app-level and user-level quotas; sustained overage triggers temporary blocks.",
    });
  }

  // The famous IG 2207052 — media URL not publicly fetchable. Direct
  // answer to the Google-Drive-URL pattern in the research corpus.
  if (subcode === 2207052) {
    return rejected({
      platform,
      platformResponse: res.body ?? res.raw ?? undefined,
      upstreamMessage:
        upstreamMessage ?? "The media URL is not publicly accessible.",
      rule: "instagram.media.reachable",
      remediation:
        "Instagram fetches media URLs from its own servers. The URL must be on a public CDN — not Google Drive, Dropbox 'share' links, S3 with object ACLs locked, or any auth-gated host. Upload via POST /v1/media first, then reference the returned id.",
    });
  }

  if (subcode === 2207020 || lowerMsg.includes("expired")) {
    return rejected({
      platform,
      platformResponse: res.body ?? res.raw ?? undefined,
      upstreamMessage: upstreamMessage ?? "Meta container expired.",
      rule: "meta.container.expired",
      remediation:
        "Meta expires unpublished media containers after 24 hours. Re-create and publish in one flow.",
    });
  }

  if (subcode === 2207003 || lowerMsg.includes("aspect")) {
    return rejected({
      platform,
      platformResponse: res.body ?? res.raw ?? undefined,
      upstreamMessage: upstreamMessage ?? "Aspect ratio out of range.",
      rule: "instagram.media.aspect_ratio",
      remediation:
        "Instagram requires aspect ratios between 4:5 and 1.91:1 for feed images, and 9:16 for Reels. Re-encode to match.",
    });
  }

  if (code === 100) {
    let remediation =
      "Meta rejected the request as an invalid parameter. Inspect platformResponse.error.message for the offending field.";
    if (lowerMsg.includes("url")) {
      remediation =
        "Meta rejected a URL field — most often `link`/`media_url` not publicly reachable, or wrong scheme. Verify the URL returns 200 anonymously.";
    }
    return rejected({
      platform,
      platformResponse: res.body ?? res.raw ?? undefined,
      ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
      remediation,
    });
  }

  // Code 1 / OAuthException / generic — surface as rejected with the
  // upstream message so the dashboard's Post Log shows the real reason
  // instead of a "platform_rejected" black box.
  return rejected({
    platform,
    platformResponse: res.body ?? res.raw ?? undefined,
    ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
    ...(opts.fallbackRemediation
      ? { remediation: opts.fallbackRemediation }
      : {}),
  });
}
