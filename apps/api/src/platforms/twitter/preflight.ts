import {
  TWITTER_ALT_TEXT_MAX_GRAPHEMES,
  TWITTER_GIF_MAX_BYTES,
  TWITTER_IMAGE_MAX_BYTES,
  TWITTER_MAX_GRAPHEMES,
  TWITTER_MAX_IMAGES,
  TWITTER_TCO_URL_LENGTH,
  TWITTER_VIDEO_MAX_BYTES,
} from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";
import {
  assertNonEmpty,
  countGraphemes,
} from "../_shared/preflight.js";

const PLATFORM = "twitter";

const ALLOWED_IMAGE_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const ALLOWED_GIF_MIMES = new Set<string>(["image/gif"]);
const ALLOWED_VIDEO_MIMES = new Set<string>(["video/mp4"]);

/**
 * twitter-text v3 weighted ranges that count as 1 unit. Every code point
 * OUTSIDE these ranges (CJK, most non-Latin scripts, emoji, variation
 * selectors, regional indicators, …) weighs 2 against the 280 budget.
 * See https://github.com/twitter/twitter-text (config/v3.json).
 */
const WEIGHT_ONE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

function isWeightOneCodePoint(cp: number): boolean {
  for (const [lo, hi] of WEIGHT_ONE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * X's weighted length: iterate by grapheme cluster so a multi-code-point
 * emoji (including ZWJ sequences like 👨‍👩‍👧‍👦) counts as a single unit rather
 * than per code point. A cluster weighs 2 if any of its code points falls
 * outside the weight-1 ranges — that captures emoji, CJK, and other
 * non-Latin text; otherwise it weighs 1.
 */
function countWeightedUnits(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let total = 0;
  for (const { segment } of segmenter.segment(text)) {
    let weight = 1;
    for (const ch of segment) {
      if (!isWeightOneCodePoint(ch.codePointAt(0)!)) {
        weight = 2;
        break;
      }
    }
    total += weight;
  }
  return total;
}

/**
 * URL-shortening-aware weighted length. t.co wraps every URL — regardless of
 * the real length — to a fixed character count. Our counter subtracts the
 * URL's weighted units and adds {@link TWITTER_TCO_URL_LENGTH}, so a 300-char
 * shortlink costs the same 23 characters as a 30-char one.
 *
 * Non-URL text is weighted per X's twitter-text v3 counter: weight-1 for the
 * ranges in {@link WEIGHT_ONE_RANGES}, weight-2 for everything else. RFC-3987
 * IRIs and unicode-normalised hosts are the edge case we consciously defer.
 */
export function countTwitterWeightedGraphemes(text: string): number {
  // Naive URL match covering http:// and https://. This is intentionally
  // generous about what counts as "the URL" — the weight adjustment is a
  // subtract-and-replace, so over-matching inside the URL just shifts which
  // codepoints are inside vs outside the 23-char block. Net weight is still
  // correct.
  const URL_RE = /https?:\/\/[^\s]+/gi;
  let total = countWeightedUnits(text);
  const matches = text.match(URL_RE);
  if (!matches) return total;
  for (const url of matches) {
    // Subtract the URL's weighted units, add the fixed t.co weight.
    total -= countWeightedUnits(url);
    total += TWITTER_TCO_URL_LENGTH;
  }
  return total;
}

export function validateTwitterText(text: string): void {
  assertNonEmpty(text, {
    rule: "twitter.text.non_empty",
    platform: PLATFORM,
  });
  const weighted = countTwitterWeightedGraphemes(text);
  if (weighted > TWITTER_MAX_GRAPHEMES) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `Tweet weight is ${weighted} graphemes (URL-shortened); X allows at most ${TWITTER_MAX_GRAPHEMES}.`,
      rule: "twitter.text.max_graphemes",
      platform: PLATFORM,
      remediation: `Shorten the tweet — every link counts as ${TWITTER_TCO_URL_LENGTH} characters regardless of length.`,
    });
  }
}

/**
 * A single media item resolved to bytes — used for mime + size preflight
 * independent of whether the caller supplied url or bytesBase64.
 */
export interface TwitterResolvedMediaItem {
  kind: "image" | "video";
  mimeType: string;
  byteLength: number;
  altText?: string;
}

/**
 * Pre-resolve checks on caller-provided shape: count + image/video
 * exclusivity + alt-text length. None of these need bytes, so failing
 * here saves a fetch storm when someone passes 5 image URLs.
 */
export interface TwitterShapeCheckItem {
  kind: "image" | "video";
  altText?: string;
}

export function validateTwitterMediaShape(
  items: readonly TwitterShapeCheckItem[],
): void {
  if (items.length === 0) return;

  const images = items.filter((m) => m.kind === "image");
  const videos = items.filter((m) => m.kind === "video");

  if (images.length > 0 && videos.length > 0) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message:
        "Cannot attach both images and video to the same tweet — X requires picking one.",
      rule: "twitter.media.image_video_exclusive",
      platform: PLATFORM,
      remediation:
        "Split into separate tweets: one with images, one with the video.",
    });
  }
  if (videos.length > 1) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `Attached ${videos.length} videos; X allows at most 1 per tweet.`,
      rule: "twitter.media.count_max",
      platform: PLATFORM,
      remediation: "Attach a single video.",
    });
  }
  if (images.length > TWITTER_MAX_IMAGES) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `Attached ${images.length} images; X allows at most ${TWITTER_MAX_IMAGES} per tweet.`,
      rule: "twitter.media.count_max",
      platform: PLATFORM,
      remediation: `Reduce to ${TWITTER_MAX_IMAGES} images or fewer.`,
    });
  }

  for (const item of items) {
    if (item.altText !== undefined) {
      const count = countGraphemes(item.altText);
      if (count > TWITTER_ALT_TEXT_MAX_GRAPHEMES) {
        throw new LetmepostError({
          code: "preflight_failed",
          status: 400,
          message: `Alt text is ${count} graphemes; X allows at most ${TWITTER_ALT_TEXT_MAX_GRAPHEMES}.`,
          rule: "twitter.media.alt_text_max_graphemes",
          platform: PLATFORM,
          remediation: `Shorten alt text to ${TWITTER_ALT_TEXT_MAX_GRAPHEMES} graphemes or fewer.`,
        });
      }
    }
  }
}

export function validateTwitterMedia(
  items: readonly TwitterResolvedMediaItem[],
): void {
  if (items.length === 0) return;
  validateTwitterMediaShape(items);

  for (const item of items) {
    if (item.kind === "image") {
      const isGif = ALLOWED_GIF_MIMES.has(item.mimeType);
      const isStatic = ALLOWED_IMAGE_MIMES.has(item.mimeType);
      if (!isGif && !isStatic) {
        throw new LetmepostError({
          code: "preflight_failed",
          status: 400,
          message: `Image mime type '${item.mimeType}' is not allowed on X.`,
          rule: "twitter.media.mime_allowed",
          platform: PLATFORM,
          remediation: `Use one of: ${[...ALLOWED_IMAGE_MIMES, ...ALLOWED_GIF_MIMES].join(", ")}.`,
        });
      }
      const ceiling = isGif ? TWITTER_GIF_MAX_BYTES : TWITTER_IMAGE_MAX_BYTES;
      if (item.byteLength > ceiling) {
        throw new LetmepostError({
          code: "preflight_failed",
          status: 400,
          message: `Image is ${item.byteLength} bytes; X allows at most ${ceiling}.`,
          rule: isGif ? "twitter.media.gif_size_max" : "twitter.media.image_size_max",
          platform: PLATFORM,
          remediation: `Re-encode under ${ceiling} bytes.`,
        });
      }
      continue;
    }

    // Video.
    if (!ALLOWED_VIDEO_MIMES.has(item.mimeType)) {
      throw new LetmepostError({
        code: "preflight_failed",
        status: 400,
        message: `Video mime type '${item.mimeType}' is not allowed on X.`,
        rule: "twitter.media.mime_allowed",
        platform: PLATFORM,
        remediation: `Use one of: ${[...ALLOWED_VIDEO_MIMES].join(", ")}.`,
      });
    }
    if (item.byteLength > TWITTER_VIDEO_MAX_BYTES) {
      throw new LetmepostError({
        code: "preflight_failed",
        status: 400,
        message: `Video is ${item.byteLength} bytes; X allows at most ${TWITTER_VIDEO_MAX_BYTES}.`,
        rule: "twitter.media.video_size_max",
        platform: PLATFORM,
        remediation: `Compress under ${TWITTER_VIDEO_MAX_BYTES} bytes.`,
      });
    }
  }
}

export { countGraphemes };
