import { z } from "zod";
import { Platform } from "./platforms.js";
import { PostStatus } from "./post-status.js";

export const BLUESKY_MAX_GRAPHEMES = 300;
export const BLUESKY_MAX_IMAGES = 4;
export const BLUESKY_IMAGE_MAX_BYTES = 1_000_000;
export const BLUESKY_VIDEO_MAX_BYTES = 100_000_000;
export const BLUESKY_ALT_TEXT_MAX_GRAPHEMES = 2000;

// Pinterest (v5 API, OAuth 2.0). Image pins use direct `media_source.url`;
// video pins go through the register-media → S3 multipart → poll → pin
// dance documented at https://developers.pinterest.com/docs/api-features/upload-media-videos.
export const PINTEREST_IMAGE_MAX_BYTES = 20_000_000;
export const PINTEREST_VIDEO_MAX_BYTES = 2_000_000_000; // 2 GB cap per Pinterest video upload spec.

// LinkedIn (Versioned REST API, OAuth 2.0 3-legged).
// LinkedIn's "ugcPost" / "/rest/posts" commentary cap is 3,000 graphemes.
// Emoji + ZWJ sequences count as 1 grapheme — same counter we use elsewhere.
export const LINKEDIN_MAX_GRAPHEMES = 3000;

// Twitter / X (v2 API, OAuth 2.0 PKCE).
// t.co wraps every URL to a fixed length regardless of the real URL length —
// the counter subtracts the real URL length and adds this constant.
export const TWITTER_MAX_GRAPHEMES = 280;
export const TWITTER_TCO_URL_LENGTH = 23;
export const TWITTER_IMAGE_MAX_BYTES = 5_000_000;
export const TWITTER_GIF_MAX_BYTES = 15_000_000;
export const TWITTER_VIDEO_MAX_BYTES = 512_000_000;
export const TWITTER_MAX_IMAGES = 4;
export const TWITTER_ALT_TEXT_MAX_GRAPHEMES = 1_000;

// Threads (Threads Graph API v1.0, standalone OAuth at threads.net).
// Caller-facing limits are taken from Meta's published Threads API docs;
// values that are absent from the docs (alt-text grapheme cap) match the
// nearest analogue (Bluesky) so callers don't see surprising platform
// disparities for the same media payload.
export const THREADS_MAX_GRAPHEMES = 500;
export const THREADS_MIN_CAROUSEL = 2;
export const THREADS_MAX_CAROUSEL = 20;
export const THREADS_IMAGE_MAX_BYTES = 8_000_000;
export const THREADS_VIDEO_MAX_BYTES = 1_000_000_000;
export const THREADS_ALT_TEXT_MAX_GRAPHEMES = 1000;

// Facebook Pages (Graph API, Facebook Login for Business).
// FB's hard server-side cap on a Page post is 63,206 chars, and the API
// will reject with code 100 above that. We pre-check at 63,206 graphemes
// (close enough; FB's counter is UTF-16 codeunits but graphemes ≤ codeunits
// so we never over-permit a payload that would 100 upstream).
export const FACEBOOK_MAX_GRAPHEMES = 63_206;
export const FACEBOOK_IMAGE_MAX_BYTES = 4_000_000; // photo upload via /photos
export const FACEBOOK_VIDEO_MAX_BYTES = 4_000_000_000; // /videos endpoint accepts up to 4GB

// TikTok (Content Posting API, OAuth 2.0 PKCE).
// Sandbox / audit-state apps cannot post publicly: privacy is forced to
// SELF_ONLY until TikTok finishes review. The `pull_by_url` upload mode
// requires a domain-verification step we have not done yet, so v1 uses
// `push_by_file` with the upload-inbox path (video.upload scope rather
// than the still-pending video.publish / Direct Post scope).
export const TIKTOK_MAX_CAPTION_CHARS = 2200;
export const TIKTOK_MAX_HASHTAG_COUNT = 100;
export const TIKTOK_VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB push_by_file ceiling
// 3s minimum, 10min ceiling on audited apps. Sandbox accounts are usually
// capped to 60s; preflight emits a warning rather than a hard fail because
// the actual ceiling is per-account and TikTok doesn't expose it through
// the creator_info endpoint.
export const TIKTOK_VIDEO_MIN_DURATION_SECONDS = 3;
export const TIKTOK_VIDEO_MAX_DURATION_SECONDS = 600;
export const TIKTOK_SANDBOX_DURATION_WARN_SECONDS = 60;
// Minimum is 540 on the short edge; TikTok recommends 1080x1920 for
// best display quality. Resolution below the minimum surfaces as a hard
// preflight fail (tiktok_resolution_unsupported).
export const TIKTOK_VIDEO_MIN_SHORT_EDGE_PX = 540;
export const TIKTOK_CHUNK_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB; TikTok max 64MiB, min 5MiB
export const TIKTOK_SINGLE_CHUNK_THRESHOLD_BYTES = 64 * 1024 * 1024;

// Instagram Business (Graph API). All Instagram publishing goes through
// the two-step container flow: create with media_url → poll status →
// publish. URLs MUST be publicly reachable; private/Drive URLs surface
// as `OAuthException 2207052`, the canonical opaque-rejection in the
// research corpus.
export const INSTAGRAM_MAX_GRAPHEMES = 2_200;
export const INSTAGRAM_MIN_CAROUSEL = 2;
export const INSTAGRAM_MAX_CAROUSEL = 10;
// JPEG only on Instagram (PNG/WebP/HEIC etc. are rejected). Container size
// limit is documented at 8 MB on the photo endpoint.
export const INSTAGRAM_IMAGE_MAX_BYTES = 8_000_000;
// Reels: 9:16 aspect, MP4/MOV, ≤ 90s, ≤ 1 GB, codec H.264 + AAC. We
// enforce size + mime at preflight; aspect/duration require a probe step
// (deferred — would need ffprobe in the worker).
export const INSTAGRAM_VIDEO_MAX_BYTES = 1_000_000_000;
export const INSTAGRAM_REELS_MAX_DURATION_SECONDS = 90;

/**
 * A single media item on a post. The caller provides bytes via one of three
 * sources:
 *   - `mediaId`     — references a prior `POST /v1/media` upload. Preferred
 *                     for production: the bytes already live on our CDN, so
 *                     publish-time latency drops by the upload roundtrip.
 *   - `url`         — passthrough; publisher fetches from a third-party CDN.
 *                     Useful for callers who already host their own assets.
 *   - `bytesBase64` — inline. Convenient for tiny images and tests; do not
 *                     use for video — multipart upload via `POST /v1/media`
 *                     is the only sane path past a few MB.
 *
 * Exactly one of the three must be set on each item.
 */
export const MEDIA_ID_PATTERN = /^med_[0-9A-Za-z]{22}$/;

const MediaSource = z
  .object({
    mediaId: z.string().regex(MEDIA_ID_PATTERN).optional(),
    url: z.string().url().optional(),
    bytesBase64: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      (v.mediaId ? 1 : 0) + (v.url ? 1 : 0) + (v.bytesBase64 ? 1 : 0) === 1,
    {
      message:
        "Exactly one of 'mediaId', 'url', or 'bytesBase64' must be provided for each media item.",
    },
  );

const MediaImage = z
  .object({
    kind: z.literal("image"),
    altText: z.string().optional(),
  })
  .and(MediaSource);

const MediaVideo = z
  .object({
    kind: z.literal("video"),
    altText: z.string().optional(),
  })
  .and(MediaSource);

export const MediaInput = z.union([MediaImage, MediaVideo]);
export type MediaInput = z.infer<typeof MediaInput>;

/**
 * Response shape for `POST /v1/media`. The `id` is what callers reference
 * back from `media: [{ kind, mediaId }]` on a post body. `url` is the
 * resolved public URL — provided so callers that prefer to send `{ url }`
 * to other systems (or just want to render a preview) don't have to
 * reconstruct it.
 */
export const CreateMediaResponse = z.object({
  id: z.string().regex(MEDIA_ID_PATTERN),
  url: z.string().url(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
});
export type CreateMediaResponse = z.infer<typeof CreateMediaResponse>;

export const FirstComment = z.object({
  text: z.string().min(1),
});
export type FirstComment = z.infer<typeof FirstComment>;

/**
 * Hard cap on `targets[]` in a single CreatePostRequest. Sized for agency
 * workloads (multiple Pages, multiple IG accounts, multiple LinkedIn pages
 * across brands). Raise when a real caller hits it — the cap exists to
 * prevent runaway fan-out from looping the same content across hundreds of
 * accounts, not to gate real workloads.
 */
export const MAX_TARGETS_PER_REQUEST = 25;

/**
 * Per-target option payload. Discriminated on `platform` so a request that
 * sends e.g. a Twitter `replyToTweetId` to a Bluesky target is caught with a
 * clean validation error at the route boundary (rule:
 * `targets.options.platform_mismatch`) rather than failing deep in a publisher.
 *
 * Replaces the v0 top-level `pinterest` / `threads` / `twitter` keys.
 */
export const TargetOptions = z
  .discriminatedUnion("platform", [
    z.object({
      platform: z.literal("twitter"),
      replyToTweetId: z.string().min(1).optional(),
      quoteTweetId: z.string().min(1).optional(),
    }),
    z.object({
      platform: z.literal("pinterest"),
      boardId: z.string().min(1).optional(),
      destinationUrl: z.string().url().optional(),
      title: z.string().min(1).optional(),
      coverImageUrl: z.string().url().optional(),
    }),
    z.object({
      platform: z.literal("threads"),
      replyToId: z.string().min(1).optional(),
    }),
    z.object({
      platform: z.literal("tiktok"),
      // Privacy level surfaced to TikTok. SELF_ONLY is forced on audit/
      // sandbox accounts regardless of caller intent; preflight rewrites
      // public_to_everyone / mutual_follow_friend to self_only and emits
      // a `tiktok_audit_self_only` warning. Default is self_only so a
      // caller who omits this on an audited account doesn't get a vague
      // 400 from upstream.
      privacy: z
        .enum(["public_to_everyone", "mutual_follow_friend", "self_only"])
        .optional(),
      // Each toggle is a separate field on TikTok's Content Posting API
      // request body. Default `false` — TikTok defaults to allowing each
      // and we mirror that, but callers can opt out per-post.
      disableComment: z.boolean().optional(),
      disableDuet: z.boolean().optional(),
      disableStitch: z.boolean().optional(),
      // Branded content disclosure. `brandOrganicToggle` is "your own
      // brand"; `brandContentToggle` is "paid partnership". Both default
      // false; setting either requires the connected account to have
      // agreed to TikTok's branded-content rules in their settings, and
      // mutual exclusivity is enforced by TikTok at publish time.
      brandContentToggle: z.boolean().optional(),
      brandOrganicToggle: z.boolean().optional(),
    }),
    // Empty-option platforms — included so callers get a clean
    // `targets.options.platform_mismatch` rule on platform/account
    // disagreement rather than an opaque `invalid discriminator value`.
    z.object({ platform: z.literal("bluesky") }),
    z.object({ platform: z.literal("facebook") }),
    z.object({ platform: z.literal("instagram") }),
    z.object({ platform: z.literal("linkedin") }),
  ])
  .superRefine((v, ctx) => {
    if (
      v.platform === "twitter" &&
      v.replyToTweetId &&
      v.quoteTweetId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Pass either `replyToTweetId` or `quoteTweetId`, not both — X rejects tweets that combine the two.",
        path: ["replyToTweetId"],
      });
    }
  });
export type TargetOptions = z.infer<typeof TargetOptions>;

/**
 * One target on a multi-target publish request. Carries either an explicit
 * accountId, an explicit platform (for single-account auto-resolution), or
 * both (in which case they must agree). Plus optional per-target overrides
 * for text / media / firstComment / options. When an override is absent the
 * target inherits the top-level default.
 */
export const PostTarget = z
  .object({
    accountId: z.string().uuid().optional(),
    platform: Platform.optional(),
    text: z.string().min(1).optional(),
    media: z.array(MediaInput).optional(),
    firstComment: FirstComment.optional(),
    options: TargetOptions.optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.accountId && !v.platform) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Each target must carry `accountId`, `platform`, or both. Pass `platform` alone when your org has exactly one connected account for that platform.",
        path: ["accountId"],
      });
    }
  });
export type PostTarget = z.infer<typeof PostTarget>;

/**
 * Multi-target post request — fans a single body out to N accounts in one
 * call. Validation rules:
 *   - `targets[]` non-empty and ≤ MAX_TARGETS_PER_REQUEST (route enforces
 *     these with rules `targets.required` and `targets.max`).
 *   - `publishNow=true` AND `scheduledAt` set → `mode_conflict`.
 *   - A target's `options.platform` must match the resolved account's
 *     platform (rule `targets.options.platform_mismatch`).
 *
 * If neither `publishNow` nor `scheduledAt` is set the request defaults to
 * immediate publish (preserves v0 semantics for the legacy shape).
 */
export const MultiTargetCreatePostRequest = z.object({
  targets: z.array(PostTarget).min(1),
  /** Default text — applied to any target that omits its own. */
  text: z.string().min(1).optional(),
  /** Default media — applied to any target that omits its own. */
  media: z.array(MediaInput).optional(),
  /** Default firstComment — applied to any target that omits its own. */
  firstComment: FirstComment.optional(),
  /** Explicit immediate publish. Mutually exclusive with `scheduledAt`. */
  publishNow: z.boolean().optional(),
  /**
   * ISO-8601 datetime. If set and in the future the whole batch is queued
   * (each target's row persisted with status="queued"). Mutually exclusive
   * with `publishNow=true`.
   */
  scheduledAt: z.string().datetime().optional(),
  /**
   * Profile scope for this batch. Required when the API key / OAuth token is
   * org-wide and the org has more than one profile. Forbidden when the API
   * key is already profile-scoped to a different profile (rule
   * `profile.scope_mismatch`). Omitting falls back to the key's bound
   * profile when one exists.
   */
  profileId: z.string().uuid().optional(),
});
export type MultiTargetCreatePostRequest = z.infer<
  typeof MultiTargetCreatePostRequest
>;

/**
 * Public CreatePostRequest — the multi-target shape is the only supported
 * shape in v1. A single-target publish is `targets: [{ accountId }]`.
 */
export const CreatePostRequest = MultiTargetCreatePostRequest;
export type CreatePostRequest = z.infer<typeof CreatePostRequest>;

/**
 * Per-target result on a multi-target publish response. `postId` is the
 * letmepost-side post row id for this target; `accountId` echoes the input
 * so a caller can correlate by position OR by id.
 */
export const PostTargetResult = z.object({
  accountId: z.string(),
  platform: z.string(),
  postId: z.string().optional(),
  status: PostStatus,
  uri: z.string().optional(),
  cid: z.string().optional(),
  firstCommentUri: z.string().optional(),
  firstCommentCid: z.string().optional(),
  warnings: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      rule: z.string().optional(),
      remediation: z.string().optional(),
      platformResponse: z.unknown().optional(),
    })
    .optional(),
});
export type PostTargetResult = z.infer<typeof PostTargetResult>;

/**
 * Top-level CreatePostResponse — one batch id plus per-target results.
 *
 * Batch `status` summarizes the per-target outcomes:
 *   - "queued":          all targets queued for a scheduled publish (202)
 *   - "published":       all targets published successfully (200)
 *   - "partial_failed":  at least one target succeeded and at least one
 *                        failed at publish time (200 with mixed results)
 *   - "failed":          every target failed (200 with all-failure results)
 *
 * Cheap shape preflight is atomic: if any target fails the synchronous
 * shape checks (text length, media count + exclusivity, alt-text length,
 * platform-options sanity) the whole batch is rejected as 400
 * validation_failed / preflight_failed before any persistence. Deep
 * preflight (URL reachability, MIME sniffing, byte caps) runs inside each
 * publisher and surfaces per-target — a batch with one deep-check failure
 * will land as `partial_failed`, not as a 400.
 */
export const CreatePostResponse = z.object({
  id: z.string(),
  status: z.enum(["queued", "published", "partial_failed", "failed"]),
  createdAt: z.string(),
  scheduledAt: z.string().optional(),
  results: z.array(PostTargetResult),
});
export type CreatePostResponse = z.infer<typeof CreatePostResponse>;

/**
 * Per-platform publish result — what each publisher returns into the
 * dispatcher. Distinct from `CreatePostResponse` (which is the public
 * multi-target envelope) so a publisher's contract stays simple: "given
 * an account + input, return the platform-level result for the one publish
 * you just performed." The dispatcher / route handler is responsible for
 * folding N PublishResults into a CreatePostResponse.
 */
export const PublishResult = z.object({
  id: z.string(),
  platform: z.string(),
  status: PostStatus.optional(),
  uri: z.string().optional(),
  cid: z.string().optional(),
  createdAt: z.string(),
  scheduledAt: z.string().optional(),
  firstCommentUri: z.string().optional(),
  firstCommentCid: z.string().optional(),
  warnings: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});
export type PublishResult = z.infer<typeof PublishResult>;
