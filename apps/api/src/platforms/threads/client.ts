import { platformFetch } from "../_shared/http.js";
import {
  authFailed,
  extractUpstreamMessage,
  rejected,
  upstreamDetail,
} from "../_shared/errors.js";
import { LetmepostError } from "../../errors.js";

const PLATFORM = "threads";

/**
 * Threads Graph API hosts. Threads has its own developer surface separate
 * from the main Facebook Graph API: the host is `graph.threads.net`, not
 * `graph.facebook.com`, and OAuth lives at `threads.net/oauth/authorize`
 * rather than the FB Login URL. Don't share base URLs across providers —
 * even where the schema looks similar, the per-platform error envelopes
 * and field names diverge enough that branching here pays for itself.
 *
 * THREADS_API_BASE / THREADS_OAUTH_BASE are env-overridable mostly to
 * point tests at a fixture server; production has no sandbox split (Meta
 * lets test users hit production while the app is in Dev Mode).
 */
export const THREADS_API_BASE =
  process.env.THREADS_API_BASE ?? "https://graph.threads.net";
export const THREADS_API_VERSION =
  process.env.THREADS_API_VERSION ?? "v1.0";
export const THREADS_OAUTH_AUTHORIZE_URL =
  process.env.THREADS_OAUTH_AUTHORIZE_URL ?? "https://threads.net/oauth/authorize";

/** Short-lived `code → access_token` exchange. POST, x-www-form-urlencoded. */
export const THREADS_OAUTH_TOKEN_URL = `${THREADS_API_BASE}/oauth/access_token`;
/** Short → long-lived swap. GET, query-string params. */
export const THREADS_LONG_LIVED_TOKEN_URL = `${THREADS_API_BASE}/access_token`;
/** Long-lived refresh. GET, query-string params. */
export const THREADS_REFRESH_TOKEN_URL = `${THREADS_API_BASE}/refresh_access_token`;

/** Subset of `GET /me` we read at connect-time to pin the platform_account_id. */
export interface ThreadsUserAccount {
  /** Stable Threads user id; pin this as platform_account_id. */
  id: string;
  /** @-handle without leading `@`. Mutable but useful as displayName. */
  username?: string;
  name?: string;
  threads_profile_picture_url?: string;
}

/** Short-lived token response from `POST /oauth/access_token`. */
export interface ThreadsShortLivedToken {
  access_token: string;
  /** Threads user id — same value comes back here as on `GET /me`. */
  user_id: string;
}

/**
 * Long-lived token response from `GET /access_token` and
 * `GET /refresh_access_token`. Long-lived tokens last 60 days and can be
 * refreshed before expiry.
 */
export interface ThreadsLongLivedToken {
  access_token: string;
  /** Always "bearer". Threads echoes this in the Facebook style. */
  token_type: string;
  /** Seconds until expiry — typically 60 * 24 * 3600 = 5_184_000. */
  expires_in: number;
}

/**
 * Status of a media container as reported by `GET /{container-id}?fields=status`.
 *
 *   - IN_PROGRESS — still uploading or transcoding (videos)
 *   - FINISHED    — ready to publish via `POST /{user-id}/threads_publish`
 *   - ERROR       — failed; `error_message` carries the reason
 *   - EXPIRED     — created but not published within the 24h window
 *   - PUBLISHED   — already published (terminal; can't re-publish)
 */
export type ThreadsContainerStatus =
  | "IN_PROGRESS"
  | "FINISHED"
  | "ERROR"
  | "EXPIRED"
  | "PUBLISHED";

export interface ThreadsContainerStatusResponse {
  status: ThreadsContainerStatus;
  error_message?: string;
}

export type ThreadsMediaType = "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL";

/**
 * Container creation params. Threads's API takes ALL of these on the same
 * `POST /{user-id}/threads` endpoint — `media_type` controls which other
 * fields are valid. The provider builds the right shape per call.
 */
export interface ThreadsCreateContainerInput {
  mediaType: ThreadsMediaType;
  /** Caption / post body. Required for TEXT, optional for IMAGE/VIDEO/CAROUSEL. */
  text?: string;
  /** Public image URL. Required when mediaType=IMAGE. */
  imageUrl?: string;
  /** Public video URL. Required when mediaType=VIDEO. */
  videoUrl?: string;
  /** Per-image accessibility text. Threads parameter name is `alt_text`. */
  altText?: string;
  /** Mark this container as a carousel child rather than a standalone post. */
  isCarouselItem?: boolean;
  /** Carousel parent only — list of child container ids in publish order. */
  children?: string[];
  /** Threads thread id to reply under. */
  replyToId?: string;
}

/** `POST /{user-id}/threads` returns just the container id. */
export interface ThreadsCreateContainerResponse {
  id: string;
}

/** `POST /{user-id}/threads_publish` returns the published thread id. */
export interface ThreadsPublishResponse {
  id: string;
}

/**
 * Subset of `GET /{thread-id}` we use after publish to fetch the canonical
 * permalink, since the publish call doesn't return one. Threads exposes
 * `permalink` only when the field is explicitly requested.
 */
export interface ThreadsPostDetail {
  id: string;
  permalink?: string;
}

export class ThreadsClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiBase: string = THREADS_API_BASE,
    private readonly apiVersion: string = THREADS_API_VERSION,
  ) {}

  private graphUrl(path: string, query: Record<string, string> = {}): string {
    const url = new URL(`${this.apiBase}/${this.apiVersion}${path}`);
    // Threads (and the broader Graph API) authenticate via `access_token` on
    // the query string. Bearer headers are NOT accepted on this surface.
    url.searchParams.set("access_token", this.accessToken);
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  /** `GET /me?fields=id,username,name,threads_profile_picture_url`. */
  async getMe(): Promise<ThreadsUserAccount> {
    const res = await platformFetch<ThreadsUserAccount>({
      method: "GET",
      url: this.graphUrl("/me", {
        fields: "id,username,name,threads_profile_picture_url",
      }),
      platform: PLATFORM,
    });
    if (!res.ok || !res.body?.id) {
      throw mapTokenLikeError(res, {
        fallbackRemediation:
          "Re-connect the Threads account — the access token may be invalid or revoked.",
      });
    }
    return res.body;
  }

  /**
   * `POST /{user-id}/threads` — create a media container. The container id
   * returned here is **not** the published-post id — it must be passed to
   * `publishContainer` to actually appear on the user's feed.
   *
   * For VIDEO and (sometimes) IMAGE, Threads transcodes asynchronously;
   * the caller should poll `getContainerStatus` until FINISHED before
   * publishing. TEXT creations are typically synchronous-ready but we
   * still validate the status path so the publisher's polling is uniform.
   */
  async createContainer(
    userId: string,
    input: ThreadsCreateContainerInput,
  ): Promise<ThreadsCreateContainerResponse> {
    const body: Record<string, unknown> = { media_type: input.mediaType };
    if (input.text !== undefined) body.text = input.text;
    if (input.imageUrl !== undefined) body.image_url = input.imageUrl;
    if (input.videoUrl !== undefined) body.video_url = input.videoUrl;
    if (input.altText !== undefined) body.alt_text = input.altText;
    if (input.isCarouselItem) body.is_carousel_item = true;
    if (input.children && input.children.length > 0) {
      body.children = input.children.join(",");
    }
    if (input.replyToId !== undefined) body.reply_to_id = input.replyToId;

    const res = await platformFetch<ThreadsCreateContainerResponse>({
      method: "POST",
      url: this.graphUrl(`/${encodeURIComponent(userId)}/threads`),
      headers: { "Content-Type": "application/json" },
      body,
      platform: PLATFORM,
    });

    if (res.ok && res.body?.id) return res.body;
    throw mapPublishError(res);
  }

  /**
   * `GET /{container-id}?fields=status,error_message` — poll until terminal.
   * Returns the raw status; the publisher decides what to do with it.
   */
  async getContainerStatus(
    containerId: string,
  ): Promise<ThreadsContainerStatusResponse> {
    const res = await platformFetch<ThreadsContainerStatusResponse>({
      method: "GET",
      url: this.graphUrl(`/${encodeURIComponent(containerId)}`, {
        fields: "status,error_message",
      }),
      platform: PLATFORM,
    });
    if (!res.ok || !res.body?.status) {
      throw mapTokenLikeError(res, {
        fallbackRemediation:
          "Threads container status fetch failed; the container id may be invalid.",
      });
    }
    return res.body;
  }

  /**
   * `POST /{user-id}/threads_publish` — flip a FINISHED container into a
   * live post. Returns the post id. Threads does NOT include the permalink
   * in this response; fetch it via `getPost` if the caller needs a URL.
   */
  async publishContainer(
    userId: string,
    creationId: string,
  ): Promise<ThreadsPublishResponse> {
    const res = await platformFetch<ThreadsPublishResponse>({
      method: "POST",
      url: this.graphUrl(`/${encodeURIComponent(userId)}/threads_publish`),
      headers: { "Content-Type": "application/json" },
      body: { creation_id: creationId },
      platform: PLATFORM,
    });
    if (res.ok && res.body?.id) return res.body;
    throw mapPublishError(res);
  }

  /**
   * `GET /{thread-id}?fields=id,permalink` — fetched after publish to
   * surface the canonical URL on the response. Best-effort; if it fails
   * we still return the publish so the caller knows the thread went live.
   */
  async getPost(threadId: string): Promise<ThreadsPostDetail | null> {
    const res = await platformFetch<ThreadsPostDetail>({
      method: "GET",
      url: this.graphUrl(`/${encodeURIComponent(threadId)}`, {
        fields: "id,permalink",
      }),
      platform: PLATFORM,
    });
    if (!res.ok || !res.body?.id) return null;
    return res.body;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * OAuth token endpoints
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * `POST /oauth/access_token` — exchange the OAuth code for a SHORT-lived
 * token. The provider immediately swaps this for a long-lived token via
 * `exchangeForLongLivedToken` so the persisted token is the 60d variant.
 *
 * Threads accepts client_secret in the body (Facebook-style), unlike
 * Pinterest's Basic-Auth pattern.
 */
export async function exchangeThreadsCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<ThreadsShortLivedToken> {
  const form = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
    code: params.code,
  });

  const res = await platformFetch<ThreadsShortLivedToken>({
    method: "POST",
    url: params.tokenUrl ?? THREADS_OAUTH_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token || !res.body?.user_id) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      remediation:
        "Verify the Threads client id / secret and that the redirect URI matches the app registration exactly.",
    });
  }
  return res.body;
}

/**
 * `GET /access_token?grant_type=th_exchange_token&client_secret=…&access_token=…`
 * Swaps a short-lived token for a 60-day long-lived token. Always called
 * directly after `exchangeThreadsCode` so the persisted token is the
 * long-lived one (short-lived tokens expire in ~1 hour).
 */
export async function exchangeForLongLivedToken(params: {
  clientSecret: string;
  shortLivedToken: string;
  baseUrl?: string;
}): Promise<ThreadsLongLivedToken> {
  const url = new URL(params.baseUrl ?? THREADS_LONG_LIVED_TOKEN_URL);
  url.searchParams.set("grant_type", "th_exchange_token");
  url.searchParams.set("client_secret", params.clientSecret);
  url.searchParams.set("access_token", params.shortLivedToken);

  const res = await platformFetch<ThreadsLongLivedToken>({
    method: "GET",
    url: url.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      remediation:
        "Threads rejected the short→long token swap. The short-lived token may have already expired (1h window) or the client secret is wrong.",
    });
  }
  return res.body;
}

/**
 * `GET /refresh_access_token?grant_type=th_refresh_token&access_token=…`
 * Long-lived tokens can be refreshed any time after the first 24 hours
 * and before the 60-day expiry.
 */
export async function refreshLongLivedToken(params: {
  longLivedToken: string;
  baseUrl?: string;
}): Promise<ThreadsLongLivedToken> {
  const url = new URL(params.baseUrl ?? THREADS_REFRESH_TOKEN_URL);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", params.longLivedToken);

  const res = await platformFetch<ThreadsLongLivedToken>({
    method: "GET",
    url: url.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      remediation:
        "Threads token refresh failed — the long-lived token may be expired (60d) or the user revoked access. Have the user re-connect the account.",
    });
  }
  return res.body;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Error classification
 *
 * Meta's Graph API surfaces errors as
 *   { error: { code, error_subcode, message, type, fbtrace_id } }
 * Common codes we map:
 *   - 190 — invalid/expired access token
 *   - 4   — application request limit reached (rate limit)
 *   - 10  — permission denied (scope)
 *   - 100 — invalid parameter (most "bad URL", "bad media" failures)
 *   - 1   — unknown error / transient
 * ───────────────────────────────────────────────────────────────────────── */

interface MetaErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
    type?: string;
    fbtrace_id?: string;
  };
}

function mapTokenLikeError(
  res: { body: unknown; status: number; raw: string | null },
  opts: { fallbackRemediation: string },
) {
  const meta = res.body as MetaErrorBody | undefined;
  const code = meta?.error?.code;
  const upstreamMessage =
    extractUpstreamMessage(res.body) ?? meta?.error?.message;

  if (res.status === 401 || code === 190 || code === 102) {
    return authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      remediation:
        "Re-connect the Threads account — the access token is invalid, expired, or revoked.",
    });
  }
  return rejected({
    platform: PLATFORM,
    platformResponse: upstreamDetail(res),
    ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
    remediation: opts.fallbackRemediation,
  });
}

function mapPublishError(res: {
  body: unknown;
  status: number;
  raw: string | null;
}) {
  const meta = res.body as MetaErrorBody | undefined;
  const code = meta?.error?.code;
  const subcode = meta?.error?.error_subcode;
  const upstreamMessage =
    extractUpstreamMessage(res.body) ?? meta?.error?.message;
  const lowerMsg = (upstreamMessage ?? "").toLowerCase();

  // Token problems.
  if (res.status === 401 || code === 190 || code === 102) {
    return authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      remediation:
        "Re-connect the Threads account — the access token is invalid, expired, or revoked.",
    });
  }

  // Permission / scope.
  if (code === 10 || code === 200) {
    return authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      remediation:
        "Threads rejected the request for a missing permission. Reconnect the account to grant `threads_content_publish`.",
    });
  }

  // Transient upstream failures — rate limits (429 / codes 4,17,32,613),
  // 5xx responses, and Meta's "unknown error, please retry" codes (1 & 2).
  // These are RETRYABLE: surface as platform_unavailable so the queue worker
  // backs off and retries instead of permanently dropping the post.
  if (
    res.status === 429 ||
    res.status >= 500 ||
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    code === 1 ||
    code === 2
  ) {
    const rateLimited =
      res.status === 429 ||
      code === 4 ||
      code === 17 ||
      code === 32 ||
      code === 613;
    return new LetmepostError({
      code: "platform_unavailable",
      status: 503,
      platform: PLATFORM,
      message: `${PLATFORM} is temporarily unavailable${
        upstreamMessage ? `: ${upstreamMessage}` : "."
      }`,
      remediation: rateLimited
        ? "Back off and retry; Threads enforces app- and user-level quotas."
        : "Threads returned a transient error; retry shortly.",
      platformResponse: upstreamDetail(res),
    });
  }

  // Parameter problems — most "bad URL", "video too short", "alt text too
  // long" rejections come back here. Heuristic on the message body keeps
  // the upstream phrasing visible while giving users a concrete next step.
  if (code === 100) {
    let remediation =
      "Threads rejected the request as an invalid parameter; inspect platformResponse for the offending field.";
    if (lowerMsg.includes("url") && lowerMsg.includes("not")) {
      remediation =
        "Ensure media URLs are publicly reachable (HTTP 200) and serve a Threads-supported mime type.";
    } else if (lowerMsg.includes("aspect") || lowerMsg.includes("size")) {
      remediation =
        "Threads rejected the media for shape/size — re-encode within the documented image (320×320 min, 8MB max) or video (≤1GB, ≤5min) limits.";
    }
    return rejected({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
      remediation,
    });
  }

  // Container expired (24h since creation).
  if (subcode === 2207020 || lowerMsg.includes("expired")) {
    return rejected({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      upstreamMessage: upstreamMessage ?? "Threads container expired.",
      remediation:
        "Threads expires unpublished media containers after 24 hours. Re-create and publish in a single flow.",
    });
  }

  return rejected({
    platform: PLATFORM,
    platformResponse: upstreamDetail(res),
    ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
  });
}
