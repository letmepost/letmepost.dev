import { platformFetch } from "../_shared/http.js";
import {
  authFailed,
  extractUpstreamMessage,
  rejected,
} from "../_shared/errors.js";
import { LetmepostError } from "../../errors.js";

const PLATFORM = "tiktok";

/**
 * TikTok Content Posting API + OAuth 2.0 (PKCE).
 *
 * v1 paths the publisher touches:
 *   - POST /v2/oauth/token/                       — exchange + refresh tokens
 *   - GET  /v2/user/info/                         — connect-time identity
 *   - POST /v2/post/publish/creator_info/query/   — read the per-account
 *                                                    privacy-level allowlist
 *                                                    (used to detect audit mode)
 *   - POST /v2/post/publish/inbox/video/init/     — start a push_by_file upload
 *                                                    to the user's inbox
 *   - PUT  <upload_url>                            — upload chunked bytes
 *   - POST /v2/post/publish/status/fetch/         — async publish-status poll
 *
 * Audit-state apps (scopes user.info.basic + video.upload only) can ONLY
 * post to the upload inbox with privacy=SELF_ONLY. The `creator_info`
 * response confirms which privacy levels TikTok will accept for this
 * account; the provider reads it at connect time and the publisher
 * defends against drift at publish time.
 */
export const TIKTOK_API_BASE =
  process.env.TIKTOK_API_BASE ?? "https://open.tiktokapis.com";
export const TIKTOK_OAUTH_TOKEN_URL = `${TIKTOK_API_BASE}/v2/oauth/token/`;
export const TIKTOK_OAUTH_AUTHORIZE_URL =
  process.env.TIKTOK_OAUTH_AUTHORIZE_URL ??
  "https://www.tiktok.com/v2/auth/authorize/";

export interface TikTokTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in?: number;
  scope: string;
  open_id?: string;
}

export interface TikTokUserInfo {
  open_id: string;
  union_id?: string;
  avatar_url?: string;
  display_name?: string;
  username?: string;
}

/**
 * Privacy values TikTok accepts on the publish request. The API expects
 * upper-snake-case strings; the dashboard / SDK surface uses lowercase to
 * match the rest of the platform options. The publisher maps between.
 */
export type TikTokPrivacyLevel =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";

export interface TikTokCreatorInfo {
  /** Privacy levels TikTok will accept on this account today. */
  privacy_level_options: TikTokPrivacyLevel[];
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  /** Per-account toggles surfaced by TikTok — false = disabled and forced. */
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  /** Ceiling on title / caption length for this account. */
  max_video_post_duration_sec?: number;
}

export interface TikTokInitInboxInput {
  videoSize: number;
  chunkSize: number;
  totalChunkCount: number;
}

export interface TikTokInitInboxResponse {
  /** Polled via /post/publish/status/fetch/. */
  publish_id: string;
  /** Presigned PUT endpoint (uploaded chunks land here). */
  upload_url: string;
}

export type TikTokPublishStatusState =
  | "PROCESSING_UPLOAD"
  | "PROCESSING_DOWNLOAD"
  | "SEND_TO_USER_INBOX"
  | "PUBLISH_COMPLETE"
  | "FAILED";

export interface TikTokPublishStatusResponse {
  status: TikTokPublishStatusState;
  /** Set when status=PUBLISH_COMPLETE — TikTok post id. */
  publicaly_available_post_id?: string[];
  /** Set when status=FAILED — TikTok's reason code. */
  fail_reason?: string;
  /** Set when status=PUBLISH_COMPLETE — public URL of the published post. */
  uploaded_bytes?: number;
}

/**
 * Wrapper used by every TikTok REST response. TikTok wraps payload data
 * under `data` and signals errors via `error.code !== "ok"`, even on a 200.
 */
interface TikTokEnvelope<T> {
  data?: T;
  error?: {
    code?: string;
    message?: string;
    log_id?: string;
  };
}

export class TikTokClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiBase: string = TIKTOK_API_BASE,
  ) {}

  /**
   * GET /v2/user/info/ — minimum identity payload used by the provider to
   * pin `platformAccountId` to the real TikTok open_id and pull a
   * displayName. `fields` is required; we ask for the same set as the
   * developer portal preview so a connected app sees consistent data.
   */
  async getUserInfo(): Promise<TikTokUserInfo> {
    const url = new URL(`${this.apiBase}/v2/user/info/`);
    url.searchParams.set(
      "fields",
      "open_id,union_id,avatar_url,display_name,username",
    );
    const res = await platformFetch<TikTokEnvelope<{ user: TikTokUserInfo }>>({
      method: "GET",
      url: url.toString(),
      headers: { Authorization: `Bearer ${this.accessToken}` },
      platform: PLATFORM,
    });
    if (res.ok && res.body?.data?.user?.open_id) {
      return res.body.data.user;
    }
    this.throwForError(res, "tiktok.user_info.unavailable");
  }

  /**
   * POST /v2/post/publish/creator_info/query/ — surface the per-account
   * privacy options. An app in audit / sandbox state will return
   * `privacy_level_options: ["SELF_ONLY"]` here; that's how the provider
   * decides whether to flag the account as audit-restricted.
   */
  async queryCreatorInfo(): Promise<TikTokCreatorInfo> {
    const res = await platformFetch<TikTokEnvelope<TikTokCreatorInfo>>({
      method: "POST",
      url: `${this.apiBase}/v2/post/publish/creator_info/query/`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: {},
      platform: PLATFORM,
    });
    if (res.ok && res.body?.data) return res.body.data;
    this.throwForError(res, "tiktok.creator_info.unavailable");
  }

  /**
   * POST /v2/post/publish/inbox/video/init/ — register a push_by_file
   * upload slot. TikTok hands back a presigned PUT endpoint plus a
   * publish_id we poll for status. Chunking is the caller's job — see
   * `TIKTOK_CHUNK_SIZE_BYTES` in schemas for the picked size.
   *
   * The `source: "FILE_UPLOAD"` discriminator selects push_by_file. The
   * alternative (pull_by_url) requires media-domain verification on
   * developer.tiktokapis.com which we have not done yet (Notion P3).
   */
  async initInboxUpload(
    input: TikTokInitInboxInput,
  ): Promise<TikTokInitInboxResponse> {
    const body = {
      source_info: {
        source: "FILE_UPLOAD",
        video_size: input.videoSize,
        chunk_size: input.chunkSize,
        total_chunk_count: input.totalChunkCount,
      },
    };
    const res = await platformFetch<TikTokEnvelope<TikTokInitInboxResponse>>({
      method: "POST",
      url: `${this.apiBase}/v2/post/publish/inbox/video/init/`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body,
      platform: PLATFORM,
    });
    if (
      res.ok &&
      res.body?.data?.publish_id &&
      res.body.data.upload_url
    ) {
      return res.body.data;
    }
    this.throwForError(res, "tiktok.upload.init_failed");
  }

  /**
   * Upload one chunk of the video bytes via the presigned PUT endpoint
   * TikTok handed back. Single-chunk uploads (file < 64 MiB) PUT the
   * whole payload at once; multi-chunk uploads PUT each slice with a
   * `Content-Range: bytes <start>-<end>/<total>` header. TikTok returns
   * 201/206/200 depending on whether the chunk completed the upload.
   */
  async uploadChunk(params: {
    uploadUrl: string;
    bytes: Uint8Array;
    contentRange: string;
    totalBytes: number;
    mimeType: string;
  }): Promise<void> {
    let res: Response;
    try {
      // Copy into a fresh Uint8Array so the BodyInit type is concrete —
      // matches the Twitter client's approach.
      const body = new Uint8Array(params.bytes.byteLength);
      body.set(params.bytes);
      res = await fetch(params.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": params.mimeType,
          "Content-Length": String(params.bytes.byteLength),
          "Content-Range": params.contentRange,
        },
        body,
        // Allow up to 10 minutes per chunk for slow uplinks. TikTok's
        // upload edge is generally fast but we have no SLA control.
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 503,
        platform: PLATFORM,
        message: isTimeout
          ? "TikTok upload chunk PUT timed out."
          : "Failed to reach TikTok's upload endpoint.",
        rule: "tiktok.upload.unreachable",
        remediation:
          "TikTok's upload edge may be transiently unreachable; retry the publish.",
      });
    }
    if (res.status >= 200 && res.status < 300) return;
    let text = "";
    try {
      text = await res.text();
    } catch {
      // ignore — surface the status code below
    }
    throw rejected({
      platform: PLATFORM,
      platformResponse: { status: res.status, body: text || null },
      upstreamMessage: text || `TikTok upload PUT returned ${res.status}.`,
      rule: "tiktok.upload.chunk_failed",
      remediation:
        "TikTok rejected the chunk upload. Verify the file mime, the chunk byte range, and that the publish_id has not expired.",
    });
  }

  /**
   * POST /v2/post/publish/status/fetch/ — async status poll. Returns the
   * current state of `publish_id`; terminal states are PUBLISH_COMPLETE
   * (success) and FAILED (TikTok rejected the upload). The worker drives
   * the polling loop, so this single call is what we expose.
   */
  async fetchPublishStatus(
    publishId: string,
  ): Promise<TikTokPublishStatusResponse> {
    const res = await platformFetch<
      TikTokEnvelope<TikTokPublishStatusResponse>
    >({
      method: "POST",
      url: `${this.apiBase}/v2/post/publish/status/fetch/`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: { publish_id: publishId },
      platform: PLATFORM,
    });
    if (res.ok && res.body?.data?.status) return res.body.data;
    this.throwForError(res, "tiktok.status.unavailable");
  }

  /**
   * Map a TikTok non-2xx (or 2xx with envelope `error.code != ok`) into
   * the canonical letmepost error shape. Auth failures and quota hits get
   * their own branches; everything else falls through to platform_rejected.
   */
  private throwForError(
    res: {
      status: number;
      body: unknown;
      raw: string | null;
    },
    fallbackRule: string,
  ): never {
    const env = (res.body ?? {}) as TikTokEnvelope<unknown>;
    const errCode = env.error?.code ?? "";
    const errMsg = env.error?.message ?? extractUpstreamMessage(res.body) ?? "";
    const lowerCode = errCode.toLowerCase();
    const lowerMsg = errMsg.toLowerCase();

    // Auth failures — TikTok signals these via 401 OR an envelope
    // error.code of "access_token_invalid" / "scope_not_authorized" on
    // an otherwise 200 response.
    if (
      res.status === 401 ||
      lowerCode.includes("access_token") ||
      lowerCode.includes("scope_not_authorized") ||
      lowerMsg.includes("invalid access token")
    ) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: res.body ?? res.raw ?? undefined,
        remediation:
          "Re-connect the TikTok account — the access token is invalid, expired, or missing the video.upload scope.",
      });
    }

    // Rate limit.
    if (
      res.status === 429 ||
      lowerCode.includes("rate_limit") ||
      lowerCode.includes("daily_quota")
    ) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: res.body ?? res.raw ?? undefined,
        upstreamMessage: errMsg || "Rate limited by TikTok.",
        rule: "tiktok.rate_limited",
        remediation:
          "Back off and retry. TikTok enforces per-app and per-user posting quotas.",
      });
    }

    // Unsupported file / format errors surface here too. Use the rule
    // hint from the caller so the post log can filter by step.
    throw rejected({
      platform: PLATFORM,
      platformResponse: res.body ?? res.raw ?? undefined,
      ...(errMsg ? { upstreamMessage: errMsg } : {}),
      rule: fallbackRule,
    });
  }
}

/**
 * Exchange a TikTok OAuth code for an access + refresh token. TikTok
 * requires `client_key` + `client_secret` in the form body (NOT a Basic
 * Authorization header — that's a Pinterest / Twitter difference). PKCE
 * verifier travels in `code_verifier`.
 */
export async function exchangeTikTokCode(params: {
  clientKey: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<TikTokTokenResponse> {
  const form = new URLSearchParams({
    client_key: params.clientKey,
    client_secret: params.clientSecret,
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });

  const res = await platformFetch<TikTokTokenResponse>({
    method: "POST",
    url: params.tokenUrl ?? TIKTOK_OAUTH_TOKEN_URL,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // TikTok rejects gzipped responses on this endpoint, but fetch
      // doesn't add Accept-Encoding by default. Leaving this empty.
    },
    body: form.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: res.body ?? res.raw ?? undefined,
      remediation:
        "Verify the TikTok client_key / client_secret, the PKCE code_verifier, and that the redirect URI matches the developer-portal registration exactly.",
    });
  }
  return res.body;
}

/**
 * Refresh a TikTok access token. Refresh tokens last 365 days and roll on
 * every use — TikTok returns a new `refresh_token` on the response which
 * the caller must persist. Failing to do so silently shortens the
 * refresh window to whatever the original token's expiry was.
 */
export async function refreshTikTokToken(params: {
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
}): Promise<TikTokTokenResponse> {
  const form = new URLSearchParams({
    client_key: params.clientKey,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });

  const res = await platformFetch<TikTokTokenResponse>({
    method: "POST",
    url: params.tokenUrl ?? TIKTOK_OAUTH_TOKEN_URL,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    platform: PLATFORM,
  });

  if (!res.ok || !res.body?.access_token) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: res.body ?? res.raw ?? undefined,
      remediation:
        "TikTok refresh token is expired, revoked, or invalid. Have the user re-connect the TikTok account.",
    });
  }
  return res.body;
}
