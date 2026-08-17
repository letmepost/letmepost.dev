import { platformFetch } from "../_shared/http.js";
import {
  authFailed,
  extractUpstreamMessage,
  rejected,
  upstreamDetail,
} from "../_shared/errors.js";
import { LetmepostError } from "../../errors.js";
import type { BlueskyBlobRef, BlueskySession } from "./client.js";

const PLATFORM = "bluesky";

/**
 * Bluesky's video service. Distinct from a user's PDS — videos are
 * transcoded + served by `did:web:video.bsky.app`, not stored as a
 * regular blob on the PDS like images are. The `app.bsky.video.uploadVideo`
 * XRPC lives here, NOT on `bsky.social`. This is the most common reason
 * naive video implementations 400 — they hit `com.atproto.repo.uploadBlob`
 * with a video/mp4, which works for tiny clips but doesn't produce the
 * playable blob ref needed for `app.bsky.embed.video`.
 *
 * Reference:
 *   https://docs.bsky.app/docs/tutorials/video
 *   https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/video/uploadVideo.json
 */
export const BLUESKY_VIDEO_BASE = "https://video.bsky.app";

/** DID of the video service — this is the audience for service auth tokens. */
export const BLUESKY_VIDEO_SERVICE_DID = "did:web:video.bsky.app";

/** Lexicon method id used as `lxm` when minting service auth for upload. */
export const BLUESKY_VIDEO_UPLOAD_LXM = "app.bsky.video.uploadVideo";

/** How long the minted service auth JWT is valid. 15 minutes — well over poll. */
const SERVICE_AUTH_EXP_SECONDS = 15 * 60;

/**
 * Job lifecycle reported by `app.bsky.video.getJobStatus`. Terminal states
 * are FAILED + the variants of completed (COMPLETED includes both encoding
 * + scanning passes done). We surface FAILED as `platform_rejected` and
 * any unknown terminal-looking state as the same — Bluesky has occasionally
 * added new states without notice.
 */
export type BlueskyVideoJobState =
  | "JOB_STATE_CREATED"
  | "JOB_STATE_ENCODING_IN_PROGRESS"
  | "JOB_STATE_SCANNING"
  | "JOB_STATE_SCANNED"
  | "JOB_STATE_COMPLETED"
  | "JOB_STATE_FAILED"
  // Older / less-common terminals seen in the wild — kept as a sum so
  // the type still narrows on string compare.
  | (string & {});

export interface BlueskyVideoJobStatus {
  jobId: string;
  did: string;
  state: BlueskyVideoJobState;
  /** Approximate transcode progress 0-100; not always populated. */
  progress?: number;
  /** Set on terminal success — this is the blob you embed. */
  blob?: BlueskyBlobRef;
  /** Upstream error code on FAILED. */
  error?: string;
  /** Upstream error message on FAILED. */
  message?: string;
}

interface UploadLimits {
  canUpload: boolean;
  remainingDailyVideos?: number;
  remainingDailyBytes?: number;
  message?: string;
  error?: string;
}

interface UploadVideoResponse {
  jobStatus: BlueskyVideoJobStatus;
}

interface GetJobStatusResponse {
  jobStatus: BlueskyVideoJobStatus;
}

interface ServiceAuthResponse {
  token: string;
}

/**
 * Mint a service auth JWT scoped narrowly to a single XRPC method on the
 * video service. The `lxm` claim binds the token to one method (here:
 * `app.bsky.video.uploadVideo`), and `exp` keeps the window short — both
 * defenses against token leakage.
 *
 * Note: `getServiceAuth` is a GET XRPC despite minting a token. Reads from
 * the user's PDS, so it uses the PDS access JWT — NOT the video service.
 */
export async function getServiceAuth(
  session: BlueskySession,
  pdsUrl: string,
  lxm: string = BLUESKY_VIDEO_UPLOAD_LXM,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SERVICE_AUTH_EXP_SECONDS;
  const url =
    `${pdsUrl}/xrpc/com.atproto.server.getServiceAuth` +
    `?aud=${encodeURIComponent(BLUESKY_VIDEO_SERVICE_DID)}` +
    `&lxm=${encodeURIComponent(lxm)}` +
    `&exp=${exp}`;

  const res = await platformFetch<ServiceAuthResponse>({
    method: "GET",
    url,
    headers: { Authorization: `Bearer ${session.accessJwt}` },
    platform: PLATFORM,
  });
  if (!res.ok || !res.body?.token) {
    throw authFailed({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      message:
        "Bluesky did not return a service auth token for the video service.",
      remediation:
        "Confirm the access JWT is fresh and the PDS supports getServiceAuth (atproto >= 0.10).",
    });
  }
  return res.body.token;
}

/**
 * Optional but cheap: ask the video service whether the user has any
 * remaining daily video / byte budget BEFORE we stream the file. Lets us
 * fail loudly with a precise reason instead of letting the upload 200
 * but the job state flip to FAILED with a quota message minutes later.
 */
export async function getUploadLimits(
  serviceAuthToken: string,
): Promise<UploadLimits | null> {
  const res = await platformFetch<UploadLimits>({
    method: "GET",
    url: `${BLUESKY_VIDEO_BASE}/xrpc/app.bsky.video.getUploadLimits`,
    headers: { Authorization: `Bearer ${serviceAuthToken}` },
    platform: PLATFORM,
  });
  // Don't fail the publish if this endpoint is unavailable — it's an
  // optimization, not a gate.
  if (!res.ok || !res.body) return null;
  return res.body;
}

/**
 * Upload raw video bytes to the video service. Returns the initial
 * jobStatus — usually `JOB_STATE_CREATED`, but can be `JOB_STATE_COMPLETED`
 * immediately if the same user uploaded the same hash before (the service
 * dedupes).
 *
 * Body is `Content-Type: video/mp4` raw bytes — NOT multipart. Filename
 * is passed via the `name` query param.
 */
export async function uploadVideo(
  serviceAuthToken: string,
  did: string,
  name: string,
  bytes: Uint8Array,
  mimeType: string,
  videoBase: string = BLUESKY_VIDEO_BASE,
): Promise<BlueskyVideoJobStatus> {
  // Strip any path-unsafe characters from `name`. Bluesky doesn't enforce
  // a particular shape but does echo this back; keep it tame.
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, "_") || "video.mp4";
  const url =
    `${videoBase}/xrpc/app.bsky.video.uploadVideo` +
    `?did=${encodeURIComponent(did)}` +
    `&name=${encodeURIComponent(safeName)}`;

  const res = await platformFetch<UploadVideoResponse>({
    method: "POST",
    url,
    headers: {
      Authorization: `Bearer ${serviceAuthToken}`,
      "Content-Type": mimeType,
    },
    body: bytes,
    platform: PLATFORM,
    // Video uploads are large + the service streams to a worker queue. Bump
    // beyond the 30s default so a 50MB upload over a slow link doesn't
    // time out before bytes finish.
    timeoutMs: 5 * 60_000,
  });
  if (!res.ok || !res.body?.jobStatus) {
    // Out-of-quota surfaces here as a 429 with `error: "TooManyRequests"` /
    // similar. Map it to a transparent rejected with a remediation that
    // mentions Bluesky's daily caps.
    throw rejected({
      platform: PLATFORM,
      platformResponse: upstreamDetail(res),
      ...(extractUpstreamMessage(res.body) !== undefined
        ? { upstreamMessage: extractUpstreamMessage(res.body)! }
        : {}),
      rule: "bluesky.video.upload_failed",
      remediation:
        "Inspect platformResponse — common causes: out of daily video quota, mp4 codec unsupported (use h.264 + AAC), or file exceeds the per-upload size limit.",
    });
  }
  return res.body.jobStatus;
}

/**
 * Poll the video service until the job reaches a terminal state. Returns
 * the resolved blob ref ready to embed in `app.bsky.embed.video`.
 *
 * Auth: the docs are explicit that `getJobStatus` accepts the same
 * service auth used for `uploadVideo`. We pass it through.
 */
export async function pollJobUntilComplete(
  serviceAuthToken: string,
  jobId: string,
  opts: { timeoutMs?: number; intervalMs?: number; videoBase?: string } = {},
): Promise<BlueskyBlobRef> {
  const timeoutMs = opts.timeoutMs ?? 6 * 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const videoBase = opts.videoBase ?? BLUESKY_VIDEO_BASE;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const res = await platformFetch<GetJobStatusResponse>({
      method: "GET",
      url:
        `${videoBase}/xrpc/app.bsky.video.getJobStatus` +
        `?jobId=${encodeURIComponent(jobId)}`,
      headers: { Authorization: `Bearer ${serviceAuthToken}` },
      platform: PLATFORM,
    });
    if (!res.ok || !res.body?.jobStatus) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        ...(extractUpstreamMessage(res.body) !== undefined
          ? { upstreamMessage: extractUpstreamMessage(res.body)! }
          : {}),
        rule: "bluesky.video.job_status_unavailable",
        remediation:
          "Bluesky's video service did not return a status for the job. Retry the publish.",
      });
    }
    const status = res.body.jobStatus;
    if (status.state === "JOB_STATE_COMPLETED") {
      if (!status.blob) {
        // Spec: a COMPLETED job MUST carry a blob. Loud fallback so we
        // don't silently lose the video.
        throw rejected({
          platform: PLATFORM,
          platformResponse: status,
          rule: "bluesky.video.completed_without_blob",
          remediation:
            "Bluesky reported the job complete but didn't return a blob. Re-upload.",
        });
      }
      return status.blob;
    }
    if (status.state === "JOB_STATE_FAILED") {
      throw rejected({
        platform: PLATFORM,
        platformResponse: status,
        upstreamMessage: status.message ?? status.error ?? "Job failed.",
        rule: "bluesky.video.job_failed",
        remediation:
          "Bluesky's video pipeline failed to encode the file. Common causes: unsupported codec, corrupted mp4 container, video > 60s. Re-encode and retry.",
      });
    }
    if (Date.now() >= deadline) {
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 504,
        message: `Bluesky video job ${jobId} did not finish within ${timeoutMs}ms.`,
        platform: PLATFORM,
        rule: "bluesky.video.transcode_timeout",
        remediation:
          "The transcode is still running upstream; retry the publish in a minute or two, or shorten the clip.",
      });
    }
    await delay(intervalMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
