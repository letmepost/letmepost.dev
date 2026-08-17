import { platformFetch } from "../_shared/http.js";
import {
  authFailed,
  extractUpstreamMessage,
  rejected,
  upstreamDetail,
} from "../_shared/errors.js";
import { LetmepostError } from "../../errors.js";

const PLATFORM = "pinterest";

/**
 * Pinterest API v5 hosts.
 *   - Production:  https://api.pinterest.com/v5
 *   - Sandbox:     https://api-sandbox.pinterest.com/v5
 *
 * Pinterest's Trial Access tier (every app pre-Standard-Access approval)
 * REJECTS pin creation on the production host with a hard 400/code-29
 * error pointing at the sandbox. Setting PINTEREST_API_BASE to the sandbox
 * URL routes every /v5/* call there during the trial window; clear it
 * after approval to flip back to production. The OAuth authorize URL
 * stays on `pinterest.com` — that one isn't sandboxed.
 *
 * The token-exchange endpoint lives under the same base because the v5
 * spec collocates it with the resource API; we derive it from the base so
 * a single env var swaps everything.
 */
export const PINTEREST_API_BASE =
  process.env.PINTEREST_API_BASE ?? "https://api.pinterest.com/v5";
export const PINTEREST_OAUTH_TOKEN_URL = `${PINTEREST_API_BASE}/oauth/token`;
export const PINTEREST_OAUTH_AUTHORIZE_URL =
  "https://www.pinterest.com/oauth/";

export interface PinterestTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope: string;
}

export interface PinterestCreatePinInput {
  /** Pinterest board id the pin lands on. */
  boardId: string;
  /** Caller-facing click-through URL displayed on the pin. */
  destinationUrl: string;
  /** Pin title; optional per Pinterest docs, MVP allows it through. */
  title?: string;
  /** Pin description / caption. */
  description?: string;
  /** Public image URL. Set this for image pins; mutually exclusive with `videoMediaId`. */
  imageUrl?: string;
  /**
   * Pinterest media id from `POST /v5/media` after a successful video
   * upload. Set this for video pins; mutually exclusive with `imageUrl`.
   */
  videoMediaId?: string;
  /** Required when `videoMediaId` is set — public still-frame URL for the pin. */
  coverImageUrl?: string;
}

/**
 * Upload-target descriptor returned by `POST /v5/media` when registering
 * a new video. Pinterest hands us a presigned S3 endpoint + the form
 * fields we have to echo back on the multipart upload — none of the
 * fields are documented as stable, so we pass the bag through verbatim.
 */
export interface PinterestRegisterMediaResponse {
  media_id: string;
  media_type: "video";
  upload_url: string;
  upload_parameters: Record<string, string>;
}

export type PinterestMediaStatus =
  | "registered"
  | "processing"
  | "succeeded"
  | "failed";

/** Subset of `GET /v5/media/{id}` we read while polling. */
export interface PinterestMedia {
  media_id: string;
  media_type: "image" | "video";
  status: PinterestMediaStatus;
}

export interface PinterestPin {
  id: string;
  board_id: string;
  link: string | null;
}

/** Subset of /v5/user_account we read at connect-time. */
export interface PinterestUserAccount {
  /** Stable account id — Pinterest also exposes `username` (mutable). */
  id: string;
  username: string;
  account_type?: string;
  profile_image?: string;
}

/** Subset of /v5/boards items we care about — id + name only. */
export interface PinterestBoardSummary {
  id: string;
  name: string;
  privacy?: "PUBLIC" | "PROTECTED" | "SECRET";
}

interface PinterestBoardsListResponse {
  items: PinterestBoardSummary[];
  bookmark?: string | null;
}

export class PinterestClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiBase: string = PINTEREST_API_BASE,
  ) {}

  /**
   * POST /v5/pins — create a pin. Pinterest returns 201 + pin body on success.
   *
   * Error mapping:
   *   - 401 / invalid_token  → platform_auth_failed
   *   - 409 or `duplicate` in message → platform_rejected with duplicate remediation
   *   - 400 with URL-reachability message → platform_rejected (passthrough)
   *   - 429                  → platform_rejected with rate-limit remediation
   *   - other non-2xx        → platform_rejected
   */
  async createPin(input: PinterestCreatePinInput): Promise<PinterestPin> {
    // Branch the media_source shape based on whether this is an image or
    // video pin. Both source types live on the same /v5/pins endpoint —
    // Pinterest infers the pin type from the source_type alone.
    const mediaSource: Record<string, unknown> = input.videoMediaId
      ? {
          source_type: "video_id",
          media_id: input.videoMediaId,
          // Pinterest's video pin spec requires a publicly reachable
          // cover image URL. The publisher enforces this in preflight,
          // so we trust the caller here.
          ...(input.coverImageUrl
            ? { cover_image_url: input.coverImageUrl }
            : {}),
        }
      : {
          source_type: "image_url",
          url: input.imageUrl,
        };

    const body: Record<string, unknown> = {
      board_id: input.boardId,
      link: input.destinationUrl,
      media_source: mediaSource,
    };
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;

    const res = await platformFetch<PinterestPin>({
      method: "POST",
      url: `${this.apiBase}/pins`,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
      body,
      platform: PLATFORM,
    });

    if (res.ok && res.body?.id) return res.body;

    // Auth failures — 401 is the common signal; some Pinterest errors also
    // report `code: 9` (permission scope) or message including "invalid_token".
    const upstreamMessage = extractUpstreamMessage(res.body);
    const lowerMsg = (upstreamMessage ?? "").toLowerCase();
    if (res.status === 401 || lowerMsg.includes("invalid_token")) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        remediation:
          "Re-connect the Pinterest account — the access token is invalid or revoked.",
      });
    }

    // Rate-limit.
    if (res.status === 429) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage: upstreamMessage ?? "Rate limited by Pinterest.",
        remediation:
          "Back off and retry; Pinterest enforces per-app and per-account quotas.",
      });
    }

    // Duplicate-pin detection. Pinterest's surface language here varies — we
    // check a few canonical phrases used in the v5 error schema.
    if (
      res.status === 409 ||
      lowerMsg.includes("duplicate") ||
      lowerMsg.includes("already exists")
    ) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage: upstreamMessage ?? "Duplicate pin.",
        remediation:
          "Pinterest rejected the pin as a duplicate of an existing pin on this board.",
      });
    }

    // Unreachable / invalid image URL.
    if (
      lowerMsg.includes("image") &&
      (lowerMsg.includes("unreachable") ||
        lowerMsg.includes("invalid") ||
        lowerMsg.includes("could not fetch"))
    ) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage: upstreamMessage ?? "Pinterest could not fetch the image URL.",
        remediation:
          "Ensure the image URL is publicly reachable and serves a supported image mime type.",
      });
    }

    throw rejected({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
    });
  }

  /**
   * `POST /v5/media` — register a new media upload slot. Returns the
   * presigned S3 endpoint + form-field bag we have to echo on the
   * subsequent multipart upload. Pinterest only exposes async video
   * upload through this two-step path; there is no synchronous video pin.
   */
  async registerMedia(): Promise<PinterestRegisterMediaResponse> {
    const res = await platformFetch<PinterestRegisterMediaResponse>({
      method: "POST",
      url: `${this.apiBase}/media`,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: { media_type: "video" },
      platform: PLATFORM,
    });

    if (
      res.ok &&
      res.body?.media_id &&
      res.body.upload_url &&
      res.body.upload_parameters
    ) {
      return res.body;
    }

    const upstreamMessage = extractUpstreamMessage(res.body);
    if (
      res.status === 401 ||
      (upstreamMessage ?? "").toLowerCase().includes("invalid_token")
    ) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        remediation:
          "Re-connect the Pinterest account — the access token is invalid or revoked.",
      });
    }

    throw rejected({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
      rule: "pinterest.media.register_failed",
      remediation:
        "Pinterest refused to register a video upload slot — most commonly missing the boards:write / pins:write scope on the connected account.",
    });
  }

  /**
   * Upload video bytes to the presigned S3 endpoint Pinterest handed back.
   * The endpoint expects multipart/form-data containing every field in
   * `upload_parameters` PLUS a final `file` field with the bytes.
   *
   * S3 returns 204 No Content on success — anything else is a hard fail.
   */
  async uploadVideoBytes(params: {
    uploadUrl: string;
    uploadParameters: Record<string, string>;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<void> {
    const form = new FormData();
    // Pinterest's order matters for S3: every signed parameter MUST come
    // before the file part. We iterate the bag, then append `file` last.
    for (const [k, v] of Object.entries(params.uploadParameters)) {
      form.append(k, v);
    }
    const part = new Uint8Array(params.bytes.byteLength);
    part.set(params.bytes);
    form.append(
      "file",
      new Blob([part], { type: params.mimeType }),
      "video.bin",
    );

    let res: Response;
    try {
      res = await fetch(params.uploadUrl, {
        method: "POST",
        body: form,
        // S3 streams the upload — give it more rope for multi-hundred-MB
        // videos over slow connections.
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 503,
        platform: PLATFORM,
        message: isTimeout
          ? "Pinterest's upload S3 endpoint timed out."
          : "Failed to reach Pinterest's upload S3 endpoint.",
        rule: "pinterest.video.upload_unreachable",
        remediation:
          "The S3 upload target may be transiently unreachable; retry the publish.",
      });
    }

    if (res.status >= 200 && res.status < 300) return;

    // S3 returns XML on error — surface verbatim because the user (or
    // Pinterest support) needs the AWS-style error code to debug a
    // signature mismatch or bucket-policy reject.
    const text = await res.text();
    throw rejected({
      platform: PLATFORM,
      platformResponse: { status: res.status, body: text },
      upstreamMessage: text || `S3 returned ${res.status}.`,
      rule: "pinterest.video.upload_failed",
      remediation:
        "Pinterest's S3 upload rejected the bytes. Common causes: signed-URL clock skew, file mime mismatch, or the file size exceeded the registered slot. Retry; if it persists the registered slot has expired.",
    });
  }

  /**
   * `GET /v5/media/{id}` — poll until the media transcode finishes.
   * Pinterest's docs say transcode is "usually" under a minute for short
   * clips; we cap at 5 min to match the Twitter ceiling. `failed` surfaces
   * as a `platform_rejected`.
   */
  async waitForMediaReady(
    mediaId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const res = await platformFetch<PinterestMedia>({
        method: "GET",
        url: `${this.apiBase}/media/${encodeURIComponent(mediaId)}`,
        headers: { Authorization: `Bearer ${this.accessToken}` },
        platform: PLATFORM,
      });
      if (!res.ok || !res.body) {
        throw rejected({
          platform: PLATFORM,
          platformResponse: upstreamDetail(res),
          ...(extractUpstreamMessage(res.body) !== undefined
            ? { upstreamMessage: extractUpstreamMessage(res.body)! }
            : {}),
          rule: "pinterest.media.status_unavailable",
          remediation:
            "Pinterest did not return media status — retry the publish.",
        });
      }
      if (res.body.status === "succeeded") return;
      if (res.body.status === "failed") {
        throw rejected({
          platform: PLATFORM,
          platformResponse: res.body,
          rule: "pinterest.video.transcode_failed",
          remediation:
            "Pinterest's video transcode failed. Common causes: codec other than h.264 + AAC, mp4 container errors, video > 5 min. Re-encode and retry.",
        });
      }
      if (Date.now() >= deadline) {
        throw new LetmepostError({
          code: "platform_unavailable",
          status: 504,
          platform: PLATFORM,
          message: `Pinterest media ${mediaId} did not finish transcoding within ${timeoutMs}ms.`,
          rule: "pinterest.video.transcode_timeout",
          remediation:
            "Pinterest is still processing the video; retry the publish in a minute or two.",
        });
      }
      await sleep(intervalMs);
    }
  }

  /**
   * GET /v5/user_account — used at connect-time to pin a real, stable
   * platform_account_id (and a friendly displayName) instead of the
   * synthetic `pinterest-${uuid}` placeholder.
   */
  async getUserAccount(): Promise<PinterestUserAccount> {
    const res = await platformFetch<PinterestUserAccount>({
      method: "GET",
      url: `${this.apiBase}/user_account`,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      platform: PLATFORM,
    });
    if (!res.ok || !res.body) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage:
          extractUpstreamMessage(res.body) ??
          "Pinterest /v5/user_account did not return a user.",
      });
    }
    return res.body;
  }

  /**
   * POST /v5/boards — create a board on the caller's account. Used by the
   * dashboard's "Create board" flow to recover from boardless connects
   * without forcing the user to leave for pinterest.com. Requires the
   * `boards:write` scope on the connected account.
   */
  async createBoard(input: {
    name: string;
    description?: string;
    /** Defaults server-side to PUBLIC; null/undefined = let Pinterest decide. */
    privacy?: "PUBLIC" | "PROTECTED" | "SECRET";
  }): Promise<PinterestBoardSummary> {
    const body: Record<string, unknown> = { name: input.name };
    if (input.description !== undefined) body.description = input.description;
    if (input.privacy !== undefined) body.privacy = input.privacy;

    const res = await platformFetch<PinterestBoardSummary>({
      method: "POST",
      url: `${this.apiBase}/boards`,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body,
      platform: PLATFORM,
    });

    if (res.ok && res.body?.id) return res.body;

    const upstreamMessage = extractUpstreamMessage(res.body);
    const lowerMsg = (upstreamMessage ?? "").toLowerCase();
    if (
      res.status === 401 ||
      lowerMsg.includes("invalid_token") ||
      lowerMsg.includes("scope")
    ) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        remediation:
          "Pinterest rejected board creation — likely the connected account predates the boards:write scope. Reconnect Pinterest from the dashboard.",
      });
    }
    if (
      res.status === 409 ||
      lowerMsg.includes("duplicate") ||
      lowerMsg.includes("already exists") ||
      lowerMsg.includes("name already")
    ) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage:
          upstreamMessage ?? "A board with that name already exists.",
        remediation:
          "Pick a different board name; Pinterest enforces unique names per account.",
      });
    }

    throw rejected({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      ...(upstreamMessage !== undefined ? { upstreamMessage } : {}),
    });
  }

  /**
   * GET /v5/boards — first page only (Pinterest paginates with `bookmark`,
   * but the connect flow only needs the first page to seed `defaultBoardId`).
   * Dashboard refreshes call this directly via a v1 endpoint.
   */
  async listBoards(opts: {
    pageSize?: number;
  } = {}): Promise<PinterestBoardSummary[]> {
    const url = new URL(`${this.apiBase}/boards`);
    url.searchParams.set(
      "page_size",
      String(Math.min(Math.max(opts.pageSize ?? 25, 1), 250)),
    );
    const res = await platformFetch<PinterestBoardsListResponse>({
      method: "GET",
      url: url.toString(),
      headers: { Authorization: `Bearer ${this.accessToken}` },
      platform: PLATFORM,
    });
    if (!res.ok || !res.body) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        upstreamMessage:
          extractUpstreamMessage(res.body) ??
          "Pinterest /v5/boards did not return a list.",
      });
    }
    return res.body.items ?? [];
  }
}

/**
 * Exchange an auth code for tokens. Shared by the provider on connect and
 * a separate path (unused in MVP) for re-connection flows.
 */
export async function exchangePinterestCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<PinterestTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  const basic = Buffer.from(
    `${params.clientId}:${params.clientSecret}`,
  ).toString("base64");

  const res = await platformFetch<PinterestTokenResponse>({
    method: "POST",
    url: params.tokenUrl ?? PINTEREST_OAUTH_TOKEN_URL,
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
        "Verify the Pinterest client id / secret and the redirect URI matches the app registration.",
    });
  }
  return res.body;
}

export async function refreshPinterestToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
}): Promise<PinterestTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });
  const basic = Buffer.from(
    `${params.clientId}:${params.clientSecret}`,
  ).toString("base64");

  const res = await platformFetch<PinterestTokenResponse>({
    method: "POST",
    url: params.tokenUrl ?? PINTEREST_OAUTH_TOKEN_URL,
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
        "The Pinterest refresh token is expired or revoked — have the user re-connect the account.",
    });
  }
  return res.body;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raised by preflight when URL reachability is probed via HEAD. */
export function unreachableUrl(url: string, detail: string): LetmepostError {
  return new LetmepostError({
    code: "preflight_failed",
    status: 400,
    message: `URL unreachable: ${url} (${detail}).`,
    rule: "pinterest.url.reachable",
    platform: PLATFORM,
    remediation:
      "Pinterest needs the image + destination URLs to be publicly reachable; verify they return 200.",
  });
}
