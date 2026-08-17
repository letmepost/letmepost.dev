import { platformFetch } from "../_shared/http.js";
import {
  authFailed,
  extractUpstreamMessage,
  rejected,
  upstreamDetail,
} from "../_shared/errors.js";
import { LetmepostError } from "../../errors.js";

const PLATFORM = "twitter";

/**
 * Twitter chunked-upload chunk size. Spec ceiling is 5 MiB per APPEND;
 * we use 4 MiB to leave headroom for the multipart envelope so a chunk
 * + boundary doesn't tip over the request size limit.
 */
const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

/**
 * Upper bound on how long we wait for X to finish transcoding a video
 * before surfacing `platform_unavailable`. Real videos finish in
 * seconds-to-a-minute; large 2-minute clips occasionally take 3-4 min.
 */
const FINALIZE_POLL_TIMEOUT_MS = 5 * 60_000;

/**
 * X / Twitter API v2 + OAuth 2.0. MVP only touches the `tweets` publish
 * endpoint and the OAuth 2.0 token endpoint.
 */
export const TWITTER_API_BASE = "https://api.twitter.com/2";
export const TWITTER_UPLOAD_BASE = "https://upload.twitter.com/1.1";
export const TWITTER_OAUTH_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
export const TWITTER_OAUTH_AUTHORIZE_URL =
  "https://twitter.com/i/oauth2/authorize";

export interface TwitterTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface TwitterCreateTweetInput {
  text: string;
  mediaIds?: string[];
  /** When set, the new tweet replies to this tweet id. Builds reply chains for threads. */
  replyToTweetId?: string;
  /** When set, the new tweet quote-tweets this tweet id. */
  quoteTweetId?: string;
}

export interface TwitterTweetResponse {
  data: {
    id: string;
    text: string;
  };
}

export interface TwitterMediaUploadResponse {
  media_id_string: string;
  size: number;
}

/**
 * Shape of the `processing_info` block returned by FINALIZE / STATUS for
 * chunked video uploads. `check_after_secs` is X's hint for when to poll
 * next; we honor it.
 */
export interface TwitterProcessingInfo {
  state: "pending" | "in_progress" | "succeeded" | "failed";
  check_after_secs?: number;
  progress_percent?: number;
  error?: {
    code?: number;
    name?: string;
    message?: string;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TwitterClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiBase: string = TWITTER_API_BASE,
    private readonly uploadBase: string = TWITTER_UPLOAD_BASE,
  ) {}

  /**
   * POST /2/tweets — create a single tweet.
   *
   * Threading is built by the caller chaining replies: post tweet 1, then
   * post tweet 2 with `replyToTweetId = id1`. We don't build a "thread"
   * primitive here because X has no atomic multi-tweet endpoint and
   * faking it server-side would lie about partial-failure semantics.
   *
   * Quote-tweet: pass `quoteTweetId`. Mutually exclusive with reply at
   * X's API level — preflight catches the combination.
   */
  async createTweet(
    input: TwitterCreateTweetInput,
  ): Promise<TwitterTweetResponse["data"]> {
    const body: Record<string, unknown> = { text: input.text };
    if (input.mediaIds && input.mediaIds.length > 0) {
      body.media = { media_ids: input.mediaIds };
    }
    if (input.replyToTweetId) {
      body.reply = { in_reply_to_tweet_id: input.replyToTweetId };
    }
    if (input.quoteTweetId) {
      body.quote_tweet_id = input.quoteTweetId;
    }

    const res = await platformFetch<TwitterTweetResponse>({
      method: "POST",
      url: `${this.apiBase}/tweets`,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body,
      platform: PLATFORM,
    });

    if (res.ok && res.body?.data?.id) return res.body.data;
    this.throwForError(res);
  }

  /**
   * `POST /1.1/media/metadata/create` — attach alt-text to a previously-
   * uploaded media id. Best-effort: if it fails (e.g. v1.1 endpoint
   * deprecation), the tweet still goes out without alt text — losing the
   * accessibility metadata is not a publish-breaking failure.
   *
   * Despite living on the v1.1 host, this endpoint is the only documented
   * way to set alt text on uploaded media. v2 has no equivalent yet.
   */
  async setMediaAltText(mediaId: string, altText: string): Promise<void> {
    await platformFetch({
      method: "POST",
      url: `${this.uploadBase}/media/metadata/create.json`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: { media_id: mediaId, alt_text: { text: altText } },
      platform: PLATFORM,
    });
    // Intentionally don't inspect the response. Per X docs, success is 2xx
    // with empty body; we don't need the response shape and we don't want
    // to fail a publish over a metadata write.
  }

  /**
   * Upload media to X. Routes between two pipes:
   *   - image / GIF → v1.1 simple upload (single base64-encoded request).
   *   - video       → v1.1 chunked upload (INIT / APPEND / FINALIZE +
   *                   STATUS poll). The simple route silently ignores
   *                   `media_category=tweet_video` past a tiny threshold
   *                   and tweets fail later with a vague "media not
   *                   ready" — so video MUST go through chunked.
   *
   * Spec: https://developer.x.com/en/docs/twitter-api/v1/media/upload-media/api-reference
   */
  async uploadMedia(bytes: Uint8Array, mimeType: string): Promise<string> {
    if (mimeType.startsWith("video/")) {
      return this.uploadVideoChunked(bytes, mimeType);
    }
    return this.uploadImageSimple(bytes, mimeType);
  }

  /**
   * v1.1 simple upload — `media_data` base64 path. The endpoint supports
   * multipart but the form-encoded base64 route is simpler and keeps the
   * fast image path free of multipart boundary handling.
   */
  private async uploadImageSimple(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<string> {
    const form = new URLSearchParams({
      media_data: Buffer.from(bytes).toString("base64"),
      media_category:
        mimeType === "image/gif" ? "tweet_gif" : "tweet_image",
    });

    const res = await platformFetch<TwitterMediaUploadResponse>({
      method: "POST",
      url: `${this.uploadBase}/media/upload.json`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      platform: PLATFORM,
    });

    if (res.ok && res.body?.media_id_string) return res.body.media_id_string;
    this.throwForError(res);
  }

  /**
   * v1.1 chunked upload for video. Four phases:
   *
   *   INIT    → declares total_bytes + mime + tweet_video category, returns
   *             a media_id we'll use for the rest of the dance.
   *   APPEND  → uploads bytes in ≤5 MiB chunks (we use 4 MiB). Multipart
   *             body with a `media` binary field. Returns 204 on success.
   *   FINALIZE→ tells X "all bytes uploaded". Response may include
   *             `processing_info` if the asset needs transcoding.
   *   STATUS  → polled when FINALIZE returned `processing_info`. We honor
   *             `check_after_secs` so we don't hammer the endpoint and
   *             flap into rate limiting on a long transcode.
   *
   * Failure modes mapped to letmepost errors:
   *   - INIT 401 / FINALIZE 401         → platform_auth_failed
   *   - APPEND non-2xx                  → platform_rejected
   *   - STATUS state=failed             → platform_rejected with X's
   *                                       reported reason
   *   - STATUS doesn't reach succeeded
   *     within FINALIZE_POLL_TIMEOUT_MS → platform_unavailable
   */
  private async uploadVideoChunked(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<string> {
    // INIT
    const initForm = new URLSearchParams({
      command: "INIT",
      total_bytes: String(bytes.byteLength),
      media_type: mimeType,
      media_category: "tweet_video",
    });
    const initRes = await platformFetch<TwitterMediaUploadResponse>({
      method: "POST",
      url: `${this.uploadBase}/media/upload.json`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: initForm.toString(),
      platform: PLATFORM,
    });
    if (!initRes.ok || !initRes.body?.media_id_string) {
      this.throwForError(initRes);
    }
    const mediaId = initRes.body.media_id_string;

    // APPEND — one segment per chunk. Sequential because X assigns segment
    // indices in upload order; parallel uploads risk reordering on retry.
    const totalChunks = Math.ceil(bytes.byteLength / CHUNK_SIZE_BYTES);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE_BYTES;
      const end = Math.min(start + CHUNK_SIZE_BYTES, bytes.byteLength);
      const chunk = bytes.subarray(start, end);
      await this.appendChunk(mediaId, i, chunk, mimeType);
    }

    // FINALIZE
    const finalizeForm = new URLSearchParams({
      command: "FINALIZE",
      media_id: mediaId,
    });
    const finalizeRes = await platformFetch<{
      media_id_string: string;
      processing_info?: TwitterProcessingInfo;
    }>({
      method: "POST",
      url: `${this.uploadBase}/media/upload.json`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: finalizeForm.toString(),
      platform: PLATFORM,
    });
    if (!finalizeRes.ok || !finalizeRes.body) {
      this.throwForError(finalizeRes);
    }

    const info = finalizeRes.body.processing_info;
    if (!info || info.state === "succeeded") {
      // Sufficiently small clips return ready immediately.
      return mediaId;
    }
    if (info.state === "failed") {
      throw rejected({
        platform: PLATFORM,
        platformResponse: info,
        upstreamMessage: info.error?.message ?? "Video processing failed.",
        rule: "twitter.media.video_processing_failed",
        remediation:
          info.error?.message ??
          "X rejected the video during processing — check codec (h.264 + AAC), duration (≤140s for tweet_video), and aspect ratio.",
      });
    }

    // STATUS poll — start with the upstream-suggested wait, then back off
    // gently if the next status still says pending.
    return this.pollMediaStatus(mediaId, info.check_after_secs ?? 1);
  }

  /**
   * APPEND a single chunk via multipart/form-data. Twitter's v1.1 endpoint
   * is the only X media path that requires multipart — INIT/FINALIZE/STATUS
   * are all url-encoded — so we keep the boundary-handling localized here.
   */
  private async appendChunk(
    mediaId: string,
    segmentIndex: number,
    chunk: Uint8Array,
    mimeType: string,
  ): Promise<void> {
    const form = new FormData();
    form.append("command", "APPEND");
    form.append("media_id", mediaId);
    form.append("segment_index", String(segmentIndex));
    // Wrap the chunk in a Blob so fetch's multipart serializer treats it
    // as a binary part with the right Content-Type.
    // Copy into a fresh ArrayBuffer-backed Uint8Array so the Blob constructor
    // gets a concrete BlobPart type (Uint8Array<SharedArrayBuffer> is rejected
    // by the lib.dom Blob signature in some TS versions).
    const part = new Uint8Array(chunk.byteLength);
    part.set(chunk);
    form.append(
      "media",
      new Blob([part], { type: mimeType }),
      `chunk-${segmentIndex}`,
    );

    let res: Response;
    try {
      res = await fetch(`${this.uploadBase}/media/upload.json`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          // Don't set Content-Type — fetch must set it with the boundary.
        },
        body: form,
        // Generous timeout; a 4MB chunk over a slow link can take a bit.
        signal: AbortSignal.timeout(2 * 60_000),
      });
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 503,
        platform: PLATFORM,
        message: isTimeout
          ? "Upstream X chunked upload timed out."
          : "Failed to reach X's chunked upload endpoint.",
        rule: "twitter.media.upload_unreachable",
        remediation:
          "The upstream X media endpoint may be unreachable; retry the publish shortly.",
      });
    }

    // 204 No Content is the documented success for APPEND.
    if (res.status >= 200 && res.status < 300) return;

    let parsed: unknown;
    let raw: string | null = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        raw = text;
      }
    }
    this.throwForError({ status: res.status, body: parsed, raw });
  }

  /**
   * Poll FINALIZE → succeeded. Twitter returns `check_after_secs` on each
   * STATUS call telling us when to come back; we respect it (capped to a
   * reasonable max so a misbehaving upstream can't stall us forever).
   */
  private async pollMediaStatus(
    mediaId: string,
    initialWaitSecs: number,
  ): Promise<string> {
    const deadline = Date.now() + FINALIZE_POLL_TIMEOUT_MS;
    let nextWaitSecs = Math.max(1, Math.min(initialWaitSecs, 30));

    while (true) {
      await delay(nextWaitSecs * 1000);

      const res = await platformFetch<{
        media_id_string: string;
        processing_info: TwitterProcessingInfo;
      }>({
        method: "GET",
        url:
          `${this.uploadBase}/media/upload.json` +
          `?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
        headers: { Authorization: `Bearer ${this.accessToken}` },
        platform: PLATFORM,
      });

      if (!res.ok || !res.body?.processing_info) {
        this.throwForError(res);
      }
      const info = res.body.processing_info;
      if (info.state === "succeeded") return mediaId;
      if (info.state === "failed") {
        throw rejected({
          platform: PLATFORM,
          platformResponse: info,
          upstreamMessage: info.error?.message ?? "Video processing failed.",
          rule: "twitter.media.video_processing_failed",
          remediation:
            info.error?.message ??
            "X rejected the video during processing — check codec, duration, and aspect ratio.",
        });
      }
      if (Date.now() >= deadline) {
        throw new LetmepostError({
          code: "platform_unavailable",
          status: 504,
          platform: PLATFORM,
          message: `X did not finish processing media ${mediaId} within ${FINALIZE_POLL_TIMEOUT_MS}ms.`,
          rule: "twitter.media.processing_timeout",
          remediation:
            "X's video transcoder is occasionally slow; retry the publish or shorten the clip.",
        });
      }
      nextWaitSecs = Math.max(1, Math.min(info.check_after_secs ?? 5, 30));
    }
  }

  private throwForError(res: {
    status: number;
    body: unknown;
    raw: string | null;
  }): never {
    const upstreamMessage = extractUpstreamMessage(res.body);
    const lowerMsg = (upstreamMessage ?? "").toLowerCase();

    // Auth failures.
    if (res.status === 401 || lowerMsg.includes("unauthorized")) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        remediation:
          "Re-connect the X account — the access token is invalid, expired, or missing scopes.",
      });
    }

    // Rate limit — RETRYABLE. Surface as platform_unavailable so the queue
    // worker backs off and retries instead of permanently dropping the post.
    if (res.status === 429) {
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 503,
        platform: PLATFORM,
        message: `X is rate limiting${
          upstreamMessage ? `: ${upstreamMessage}` : "."
        }`,
        remediation:
          "Back off and retry — X enforces per-app and per-user tweet-posting ceilings.",
        platformResponse: upstreamDetail(res),
      });
    }

    // Duplicate tweet — X reports this as code 187 inside a nested `errors`
    // array, or as a top-level `detail` containing the word "duplicate".
    if (isDuplicateTweet(res.body) || lowerMsg.includes("duplicate")) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage: upstreamMessage ?? "Duplicate tweet.",
        remediation:
          "X detected this tweet as a duplicate of a recent tweet; vary the content and retry.",
      });
    }

    // Over-length — X code 186 historically.
    if (isTweetTooLong(res.body) || lowerMsg.includes("too long")) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage: upstreamMessage ?? "Tweet too long.",
        remediation:
          "Shorten the tweet; letmepost should have caught this in preflight — file a bug.",
      });
    }

    // Unsupported media.
    if (
      lowerMsg.includes("media") &&
      (lowerMsg.includes("unsupported") || lowerMsg.includes("invalid"))
    ) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage: upstreamMessage ?? "Unsupported media.",
        remediation:
          "X rejected the media format; use a supported mime type and size.",
      });
    }

    throw rejected({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
    });
  }
}

function isDuplicateTweet(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) =>
      e &&
      typeof e === "object" &&
      (e as { code?: number }).code === 187,
  );
}

function isTweetTooLong(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) =>
      e &&
      typeof e === "object" &&
      (e as { code?: number }).code === 186,
  );
}

/* ───── OAuth 2.0 PKCE token exchange ───── */

export async function exchangeTwitterCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<TwitterTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  const basic = Buffer.from(
    `${params.clientId}:${params.clientSecret}`,
  ).toString("base64");

  const res = await platformFetch<TwitterTokenResponse>({
    method: "POST",
    url: params.tokenUrl ?? TWITTER_OAUTH_TOKEN_URL,
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      remediation:
        "Verify the X client id / secret, the PKCE code_verifier, and that the redirect URI matches the app registration.",
    });
  }
  return res.body;
}

export async function refreshTwitterToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
}): Promise<TwitterTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  const basic = Buffer.from(
    `${params.clientId}:${params.clientSecret}`,
  ).toString("base64");

  const res = await platformFetch<TwitterTokenResponse>({
    method: "POST",
    url: params.tokenUrl ?? TWITTER_OAUTH_TOKEN_URL,
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token) {
    // Transient upstream failures (429 rate-limit, 5xx) must NOT be mistaken
    // for a revoked grant. Mapping them to platform_auth_failed kills the
    // refresh chain and forces the user to re-auth over a temporary blip.
    // Surface them as retryable platform_unavailable so the refresh backs off
    // and retries; the account is left connected. (Network errors/timeouts
    // already surface as platform_unavailable from platformFetch.)
    if (res.status === 429 || res.status >= 500) {
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 503,
        platform: PLATFORM,
        message:
          res.status === 429
            ? "X is rate limiting the token-refresh endpoint."
            : `X token-refresh endpoint returned ${res.status}.`,
        remediation:
          "Transient upstream failure during token refresh; retry shortly — the account is not revoked.",
        platformResponse: upstreamDetail(res),
      });
    }

    // Everything else (400 invalid_grant, 401, invalid_token, ...) is a
    // genuine auth failure: the refresh token is expired or revoked.
    throw authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      remediation:
        "The X refresh token is expired or revoked — have the user re-connect the account.",
    });
  }
  return res.body;
}
