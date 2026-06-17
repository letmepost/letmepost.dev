import { authFailed, extractUpstreamMessage, rejected } from "../_shared/errors.js";
import { platformFetch } from "../_shared/http.js";

const PLATFORM = "linkedin";

/**
 * LinkedIn API constants.
 *
 *  - REST host: `https://api.linkedin.com`
 *  - OAuth: 3-legged authorization-code flow on `www.linkedin.com`
 *  - Versioning: every REST call must pin `LinkedIn-Version: YYYYMM`. The
 *    version is the **single load-bearing decision** of the LinkedIn
 *    integration — bumping it is one config change, never a code change.
 *    plan.md problem #2 ("LinkedIn sunset 5 versions in 6 months") is the
 *    competitor failure mode this addresses directly.
 *
 * Default version = `202605` — the most recent stable Versioned API
 * release as of June 2026. Pin via `LINKEDIN_API_VERSION` env to bump.
 */
export const LINKEDIN_API_BASE = "https://api.linkedin.com";
export const LINKEDIN_OAUTH_AUTHORIZE_URL =
  "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_OAUTH_TOKEN_URL =
  "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_DEFAULT_VERSION = "202605";

export interface LinkedInTokenResponse {
  access_token: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  expires_in: number;
  scope: string;
  id_token?: string;
}

export interface LinkedInUserInfo {
  /** Stable LinkedIn member ID; URN form is `urn:li:person:{sub}`. */
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  picture?: string;
}

export interface LinkedInPostInput {
  /** `urn:li:person:{id}` (personal) or `urn:li:organization:{id}` (org). */
  authorUrn: string;
  text: string;
  /** `PUBLIC` (default) or `CONNECTIONS`. */
  visibility?: "PUBLIC" | "CONNECTIONS";
}

export interface LinkedInPostResult {
  /** `urn:li:share:…` returned in the `x-restli-id` header. */
  urn: string;
}

export class LinkedInClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiBase: string = LINKEDIN_API_BASE,
    private readonly version: string = LINKEDIN_DEFAULT_VERSION,
  ) {}

  /**
   * Default headers for every Versioned-API call. Restli protocol = 2.0.0,
   * version pinned, JSON body. Intentionally a single source of truth so
   * version bumps are a config flip.
   */
  private versionedHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "LinkedIn-Version": this.version,
      "X-Restli-Protocol-Version": "2.0.0",
    };
  }

  /**
   * Resolve the authenticated member's stable identifier via the OIDC
   * `userinfo` endpoint (returned with `openid + profile` scopes). The
   * legacy `/v2/me` endpoint requires `r_liteprofile` which is now an
   * approval-only scope — `userinfo` is the modern recommended path.
   */
  async fetchUserInfo(): Promise<LinkedInUserInfo> {
    const res = await platformFetch<LinkedInUserInfo>({
      method: "GET",
      url: `${this.apiBase}/v2/userinfo`,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      platform: PLATFORM,
    });
    if (!res.ok || !res.body?.sub) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: res.body ?? res.raw ?? undefined,
        remediation:
          "Re-authenticate the LinkedIn account — the access token couldn't read /v2/userinfo (token revoked, expired, or missing openid+profile scopes).",
      });
    }
    return res.body;
  }

  /**
   * Create a UGC post via `/rest/posts` (Versioned API). MVP shape: text
   * only, NONE media category, PUBLISHED state. Image / video / article
   * shares + DRAFT lifecycle land in the post-MDP slice.
   *
   * Error mapping:
   *   - 401 / `INVALID_TOKEN` / `REVOKED_ACCESS_TOKEN` → platform_auth_failed
   *   - 403 / `INSUFFICIENT_PERMISSIONS`              → platform_rejected (scope hint)
   *   - 422 / `INVALID_AUTHOR`                        → platform_rejected (URN mismatch)
   *   - 429                                            → platform_rejected (rate limit)
   *   - other non-2xx                                 → platform_rejected
   */
  async createPost(input: LinkedInPostInput): Promise<LinkedInPostResult> {
    const body = {
      author: input.authorUrn,
      commentary: input.text,
      visibility: input.visibility ?? "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    const res = await platformFetch<unknown>({
      method: "POST",
      url: `${this.apiBase}/rest/posts`,
      headers: this.versionedHeaders(),
      body,
      platform: PLATFORM,
    });

    if (res.ok) {
      // LinkedIn returns 201 with the created URN in the `x-restli-id`
      // header. The body is empty on success.
      const urn = res.headers.get("x-restli-id");
      if (!urn) {
        throw rejected({
          platform: PLATFORM,
          platformResponse: res.body ?? res.raw ?? undefined,
          upstreamMessage:
            "LinkedIn accepted the post but didn't return a URN in x-restli-id — treat as ambiguous.",
        });
      }
      return { urn };
    }

    const upstreamMessage = extractUpstreamMessage(res.body);
    const code = pickErrorCode(res.body);
    const lower = (upstreamMessage ?? "").toLowerCase();

    if (
      res.status === 401 ||
      code === "INVALID_TOKEN" ||
      code === "REVOKED_ACCESS_TOKEN" ||
      lower.includes("invalid_token")
    ) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: res.body ?? res.raw ?? undefined,
        remediation:
          "The LinkedIn access token is expired or revoked — reconnect the account.",
      });
    }

    if (res.status === 403 || code === "INSUFFICIENT_PERMISSIONS") {
      throw rejected({
        platform: PLATFORM,
        platformResponse: res.body ?? res.raw ?? undefined,
        upstreamMessage:
          upstreamMessage ?? "LinkedIn refused the post — insufficient scopes.",
        remediation:
          "Reconnect with `w_member_social` (personal) or apply for MDP for `w_organization_social` (org pages).",
      });
    }

    if (
      res.status === 422 ||
      code === "INVALID_AUTHOR" ||
      lower.includes("author") ||
      lower.includes("urn")
    ) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: res.body ?? res.raw ?? undefined,
        upstreamMessage: upstreamMessage ?? "LinkedIn rejected the author URN.",
        remediation:
          "Verify the author URN matches the authenticated member; org URNs require MDP-approved scopes.",
      });
    }

    if (res.status === 429) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: res.body ?? res.raw ?? undefined,
        upstreamMessage: upstreamMessage ?? "LinkedIn rate limit hit.",
        remediation:
          "Back off — LinkedIn enforces both per-app and per-member quotas. Retry after the window.",
      });
    }

    throw rejected({
      platform: PLATFORM,
      platformResponse: res.body ?? res.raw ?? undefined,
      ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
    });
  }
}

function pickErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  // LinkedIn returns errors as { code: "INVALID_TOKEN", ... } or
  // { errorCode: 65601, message: "...", ... } depending on the surface.
  const code = (body as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return undefined;
}

/* ───── OAuth 2.0 token exchange ───── */

export async function exchangeLinkedInCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<LinkedInTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const res = await platformFetch<LinkedInTokenResponse>({
    method: "POST",
    url: params.tokenUrl ?? LINKEDIN_OAUTH_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: res.body ?? res.raw ?? undefined,
      remediation:
        "Verify the LinkedIn client id / secret and that the redirect URI matches the app registration exactly.",
    });
  }
  return res.body;
}

export async function refreshLinkedInToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
}): Promise<LinkedInTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const res = await platformFetch<LinkedInTokenResponse>({
    method: "POST",
    url: params.tokenUrl ?? LINKEDIN_OAUTH_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: res.body ?? res.raw ?? undefined,
      remediation:
        "Refresh token is expired or revoked — have the user re-connect the LinkedIn account.",
    });
  }
  return res.body;
}
