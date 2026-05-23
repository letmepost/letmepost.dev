import { spawn } from "node:child_process";
import {
  TIKTOK_MAX_CAPTION_CHARS,
  TIKTOK_MAX_HASHTAG_COUNT,
  TIKTOK_SANDBOX_DURATION_WARN_SECONDS,
  TIKTOK_VIDEO_MAX_BYTES,
  TIKTOK_VIDEO_MAX_DURATION_SECONDS,
  TIKTOK_VIDEO_MIN_DURATION_SECONDS,
  TIKTOK_VIDEO_MIN_SHORT_EDGE_PX,
  type MediaInput,
} from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";
import type { TikTokPrivacyLevel } from "./client.js";
import type { TikTokAuditState } from "./provider.js";

const PLATFORM = "tiktok";

/**
 * MIME types TikTok accepts on push_by_file. The Content Posting API
 * docs list these explicitly; anything else is a hard preflight fail
 * before we burn an upload slot.
 */
export const TIKTOK_ALLOWED_VIDEO_MIMES = new Set<string>([
  "video/mp4",
  "video/quicktime", // MOV
  "video/mpeg",
  "video/x-msvideo", // AVI
  "video/x-flv",
  "video/webm",
]);

/**
 * Publisher-facing shape — `text` is the caption, `media` is a single
 * video item, and `tiktok` carries the per-post overrides surfaced by
 * the SDK / dashboard via `options`.
 */
export interface TikTokPublishInput {
  text?: string;
  media: MediaInput[];
  privacy?: "public_to_everyone" | "mutual_follow_friend" | "self_only";
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
}

export interface TikTokPreflightWarning {
  code: string;
  message: string;
}

export interface TikTokPreflightResult {
  /** Resolved privacy level — may be overridden when account is in audit mode. */
  privacy: TikTokPrivacyLevel;
  warnings: TikTokPreflightWarning[];
}

/**
 * Map the lowercase public privacy enum (caller-facing) onto TikTok's
 * upstream upper-snake-case strings. Unknown / undefined values default
 * to SELF_ONLY — the safest choice for audited apps.
 */
function toUpstreamPrivacy(
  v: TikTokPublishInput["privacy"],
): TikTokPrivacyLevel {
  switch (v) {
    case "public_to_everyone":
      return "PUBLIC_TO_EVERYONE";
    case "mutual_follow_friend":
      return "MUTUAL_FOLLOW_FRIENDS";
    case "self_only":
    case undefined:
    default:
      return "SELF_ONLY";
  }
}

/**
 * Count hashtags in a caption. TikTok caps at 100 to avoid spam — we
 * count `#word` tokens (Unicode word characters, no whitespace inside).
 */
export function countHashtags(text: string): number {
  if (!text) return 0;
  const matches = text.match(/#[\p{L}\p{N}_]+/gu);
  return matches ? matches.length : 0;
}

/**
 * Pure shape-level validation. Caption length, media presence, hashtag
 * count, brand-content mutual exclusivity, privacy enforcement against
 * the audit state stored on the account.
 *
 * `auditState` and `privacyLevelOptions` come from the account's
 * `tokenMetadata.creatorInfo` — when present, the validator forces
 * SELF_ONLY for audit accounts and emits `tiktok.audit.self_only` so
 * the caller knows we rewrote their intent.
 */
export function validateTikTokInput(input: {
  text?: string;
  media: MediaInput[];
  privacy?: TikTokPublishInput["privacy"];
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  auditState?: TikTokAuditState;
  privacyLevelOptions?: TikTokPrivacyLevel[];
}): TikTokPreflightResult {
  const warnings: TikTokPreflightWarning[] = [];

  // Caption rules.
  if (input.text !== undefined && input.text.length > TIKTOK_MAX_CAPTION_CHARS) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `TikTok caption is ${input.text.length} characters; max is ${TIKTOK_MAX_CAPTION_CHARS}.`,
      rule: "tiktok.text.max_chars",
      platform: PLATFORM,
      remediation: `Shorten the caption to ${TIKTOK_MAX_CAPTION_CHARS} characters or fewer.`,
    });
  }
  if (input.text) {
    const hashtags = countHashtags(input.text);
    if (hashtags > TIKTOK_MAX_HASHTAG_COUNT) {
      throw new LetmepostError({
        code: "preflight_failed",
        status: 400,
        message: `TikTok caption has ${hashtags} hashtags; max is ${TIKTOK_MAX_HASHTAG_COUNT}.`,
        rule: "tiktok.text.hashtag_max",
        platform: PLATFORM,
        remediation: `Reduce the hashtag count to ${TIKTOK_MAX_HASHTAG_COUNT} or fewer.`,
      });
    }
  }

  // Media rules. TikTok unaudited apps don't support photo posts via
  // the Content Posting API, so we enforce exactly one video item.
  if (!input.media || input.media.length === 0) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: "TikTok posts require exactly one video.",
      rule: "tiktok.media.required",
      platform: PLATFORM,
      remediation:
        "Pass `media: [{ kind: \"video\", mediaId | url }]` on the request body.",
    });
  }
  if (input.media.length > 1) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: "TikTok posts support exactly one video item.",
      rule: "tiktok.media.single_only",
      platform: PLATFORM,
      remediation: "Send a single video item; photo carousels aren't supported on unaudited apps.",
    });
  }
  const only = input.media[0]!;
  if (only.kind !== "video") {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `TikTok posts require a video media item; got '${only.kind}'.`,
      rule: "tiktok.media.video_required",
      platform: PLATFORM,
      remediation: "TikTok unaudited apps only support video posts via the Content Posting API.",
    });
  }

  // Brand-content rules. TikTok rejects requests that set both toggles
  // on the same post; better to catch here than upstream.
  if (input.brandContentToggle && input.brandOrganicToggle) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message:
        "TikTok rejects posts that enable both brand_content_toggle and brand_organic_toggle.",
      rule: "tiktok.branded_content.mutual_exclusive",
      platform: PLATFORM,
      remediation:
        "Set exactly one of `brandContentToggle` (paid partnership) or `brandOrganicToggle` (your own brand).",
    });
  }

  // Privacy: audit accounts can only post SELF_ONLY. Force it and warn.
  let resolved = toUpstreamPrivacy(input.privacy);
  const allowlist = input.privacyLevelOptions ?? [];
  const isAudit =
    input.auditState === "audit" ||
    (allowlist.length === 1 && allowlist[0] === "SELF_ONLY");
  if (isAudit && resolved !== "SELF_ONLY") {
    warnings.push({
      code: "tiktok.audit.self_only",
      message:
        "TikTok account is in audit / sandbox state — privacy forced to SELF_ONLY. Submit `video.publish` for review to unlock public posting.",
    });
    resolved = "SELF_ONLY";
  } else if (allowlist.length > 0 && !allowlist.includes(resolved)) {
    // Account permits some non-SELF_ONLY options but not the requested one.
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `TikTok account does not allow privacy=${resolved}.`,
      rule: "tiktok.privacy.not_allowed",
      platform: PLATFORM,
      remediation: `TikTok permits these privacy levels on this account: ${allowlist.join(", ")}.`,
      platformResponse: { allowed: allowlist, requested: resolved },
    });
  }

  return { privacy: resolved, warnings };
}

/**
 * Byte-level + mime preflight on the resolved video bytes. Pure, no I/O.
 * The publisher calls this after `loadMediaItem` so the byte count is
 * honest regardless of how the caller supplied the media.
 */
export function validateTikTokVideoBytes(input: {
  mimeType: string;
  byteLength: number;
}): void {
  if (!TIKTOK_ALLOWED_VIDEO_MIMES.has(input.mimeType)) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `Video mime type '${input.mimeType}' is not allowed on TikTok.`,
      rule: "tiktok.file_format.invalid",
      platform: PLATFORM,
      remediation: `Use one of: ${[...TIKTOK_ALLOWED_VIDEO_MIMES].join(", ")}.`,
    });
  }
  if (input.byteLength > TIKTOK_VIDEO_MAX_BYTES) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `Video is ${input.byteLength} bytes; TikTok push_by_file allows at most ${TIKTOK_VIDEO_MAX_BYTES}.`,
      rule: "tiktok.video.size_max",
      platform: PLATFORM,
      remediation: `Compress under ${TIKTOK_VIDEO_MAX_BYTES} bytes (~4 GB).`,
    });
  }
}

/**
 * Result of an ffprobe inspection. Width / height may be undefined when
 * the video file doesn't expose them (rare; the helper logs and we
 * skip the resolution check instead of crashing).
 */
export interface TikTokVideoProbe {
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** True when ffprobe could not be invoked (binary missing, etc.). */
  ffprobeUnavailable?: boolean;
}

/**
 * Validate metadata extracted via ffprobe (duration + aspect / resolution).
 *
 * `accountAudit` controls how strict the duration check is. Sandbox /
 * audit accounts are typically capped to 60s by TikTok regardless of the
 * 600s public ceiling; we emit a warning instead of a hard fail so the
 * caller can still try the upload.
 */
export function validateTikTokVideoProbe(input: {
  probe: TikTokVideoProbe;
  accountAudit?: TikTokAuditState;
}): TikTokPreflightWarning[] {
  const warnings: TikTokPreflightWarning[] = [];
  const { probe, accountAudit } = input;

  if (probe.ffprobeUnavailable) {
    warnings.push({
      code: "tiktok.video.probe_unavailable",
      message:
        "ffprobe is not installed — TikTok duration / resolution preflight is skipped. Install ffmpeg locally to surface these checks before upload.",
    });
    return warnings;
  }

  if (typeof probe.durationSeconds === "number") {
    if (probe.durationSeconds < TIKTOK_VIDEO_MIN_DURATION_SECONDS) {
      throw new LetmepostError({
        code: "preflight_failed",
        status: 400,
        message: `Video duration ${probe.durationSeconds.toFixed(2)}s is below the TikTok minimum of ${TIKTOK_VIDEO_MIN_DURATION_SECONDS}s.`,
        rule: "tiktok.video.too_short",
        platform: PLATFORM,
        remediation: `Use a video at least ${TIKTOK_VIDEO_MIN_DURATION_SECONDS}s long.`,
      });
    }
    if (probe.durationSeconds > TIKTOK_VIDEO_MAX_DURATION_SECONDS) {
      throw new LetmepostError({
        code: "preflight_failed",
        status: 400,
        message: `Video duration ${probe.durationSeconds.toFixed(2)}s exceeds the TikTok maximum of ${TIKTOK_VIDEO_MAX_DURATION_SECONDS}s.`,
        rule: "tiktok.video.too_long",
        platform: PLATFORM,
        remediation: `Trim the video to ${TIKTOK_VIDEO_MAX_DURATION_SECONDS}s or fewer.`,
      });
    }
    if (
      accountAudit === "audit" &&
      probe.durationSeconds > TIKTOK_SANDBOX_DURATION_WARN_SECONDS
    ) {
      warnings.push({
        code: "tiktok.video.sandbox_duration",
        message: `Sandbox / audit accounts are typically capped to ${TIKTOK_SANDBOX_DURATION_WARN_SECONDS}s. This ${probe.durationSeconds.toFixed(2)}s video may be rejected at publish time.`,
      });
    }
  }

  if (typeof probe.width === "number" && typeof probe.height === "number") {
    const shortEdge = Math.min(probe.width, probe.height);
    if (shortEdge < TIKTOK_VIDEO_MIN_SHORT_EDGE_PX) {
      throw new LetmepostError({
        code: "preflight_failed",
        status: 400,
        message: `Video short-edge ${shortEdge}px is below the TikTok minimum of ${TIKTOK_VIDEO_MIN_SHORT_EDGE_PX}px.`,
        rule: "tiktok.resolution.unsupported",
        platform: PLATFORM,
        remediation: `Use a video at least ${TIKTOK_VIDEO_MIN_SHORT_EDGE_PX}px on the short edge (1080x1920 recommended).`,
      });
    }
    // Aspect-ratio guidance: 9:16 preferred, allow 1:1 and 16:9 with a
    // warning. The ratio check has a 5% tolerance — encoded videos
    // routinely have one pixel off from the nominal aspect.
    const ratio = probe.width / probe.height;
    const targets: { name: string; ratio: number; tol: number }[] = [
      { name: "9:16", ratio: 9 / 16, tol: 0.05 },
      { name: "1:1", ratio: 1, tol: 0.05 },
      { name: "16:9", ratio: 16 / 9, tol: 0.05 },
    ];
    const matched = targets.find(
      (t) => Math.abs(ratio - t.ratio) <= t.ratio * t.tol,
    );
    if (!matched) {
      warnings.push({
        code: "tiktok.video.aspect_unusual",
        message: `Video aspect ratio is ${ratio.toFixed(2)}; TikTok prefers 9:16, with 1:1 / 16:9 as acceptable alternatives.`,
      });
    } else if (matched.name !== "9:16") {
      warnings.push({
        code: "tiktok.video.aspect_non_vertical",
        message: `Video aspect ratio is ${matched.name}; TikTok recommends 9:16 vertical for best presentation.`,
      });
    }
  }

  return warnings;
}

/**
 * Best-effort ffprobe wrapper. Shells out to `ffprobe` and reads the
 * first video stream's width / height / duration. Falls back to
 * `ffprobeUnavailable: true` when the binary is missing — preflight
 * surfaces the absence as a warning instead of erroring.
 *
 * We write the bytes to a temp file because ffprobe doesn't read stdin
 * reliably across containers; it's a one-shot before publish so the
 * temp-file cost is negligible.
 */
export async function probeVideoBytes(
  bytes: Uint8Array,
): Promise<TikTokVideoProbe> {
  const { writeFile, unlink, mkdtemp } = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  let dir: string;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "tiktok-probe-"));
  } catch {
    return { ffprobeUnavailable: true };
  }
  const file = path.join(dir, "input.bin");
  try {
    await writeFile(file, bytes);
  } catch {
    return { ffprobeUnavailable: true };
  }
  try {
    const out = await runFfprobe(file);
    return out;
  } finally {
    await unlink(file).catch(() => {});
  }
}

function runFfprobe(file: string): Promise<TikTokVideoProbe> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height:format=duration",
          "-of",
          "json",
          file,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      resolve({ ffprobeUnavailable: true });
      return;
    }
    let stdout = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.on("error", () => {
      resolve({ ffprobeUnavailable: true });
    });
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        resolve({ ffprobeUnavailable: true });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{ width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const stream = parsed.streams?.[0];
        const result: TikTokVideoProbe = {};
        if (typeof stream?.width === "number") result.width = stream.width;
        if (typeof stream?.height === "number") result.height = stream.height;
        const dur = parsed.format?.duration;
        if (typeof dur === "string") {
          const parsedDur = Number.parseFloat(dur);
          if (Number.isFinite(parsedDur)) result.durationSeconds = parsedDur;
        }
        resolve(result);
      } catch {
        resolve({ ffprobeUnavailable: true });
      }
    });
  });
}
