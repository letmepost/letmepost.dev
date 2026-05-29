import {
  PLATFORM_STATE,
  type PlatformState,
} from "@letmepost/schemas/platform-state";

/**
 * Source-of-truth list of platforms surfaced on the landing site —
 * navbar, /platforms cards, the dynamic /platforms/[slug] pages, and
 * the index landing's platform-support strip all read from this file.
 *
 * Status is computed from the canonical `PLATFORM_STATE` in
 * `@letmepost/schemas` so this list cannot drift from the backend
 * connect gate. The marketing-only `planned` status is for platforms
 * we haven't built a publisher for yet (e.g. YouTube) — they're not
 * in the backend Platform enum, so they have no gate to drift from.
 */

export type PlatformStatus = PlatformState | "planned";

export type Platform = {
  /** URL slug — `/platforms/<slug>`. */
  slug: string;
  /** Display name in the navbar + page headers. */
  name: string;
  /** Phosphor icon id (without the `ph:` prefix). */
  icon: string;
  /** Live-launch status — derived from PLATFORM_STATE, never inlined. */
  status: PlatformStatus;
  /** One-liner shown under the card on /platforms-overview. */
  tagline: string;
  /** Hero subhead on the /platforms/<slug> page. */
  pitch: string;
  /** Key technical detail surfaced under the hero (API version, scope set, etc.). */
  detail: string;
  /** Whether posts to this platform support video uploads in v1. */
  videoSupport: boolean;
  /** Whether posts to this platform support multi-image carousels in v1. */
  carouselSupport: boolean;
  /** Optional anchor for a platform-specific gotcha worth surfacing. */
  gotcha?: string;
};

/** Marketing-only slugs that aren't in the backend Platform enum.
 *  Empty for now — TikTok moved into the enum once the upload-inbox
 *  publisher landed; its state is `pending` until App Review clears. */
const PLANNED_PLATFORMS: ReadonlySet<string> = new Set();

function statusFor(slug: string): PlatformStatus {
  if (PLANNED_PLATFORMS.has(slug)) return "planned";
  const fromState = (PLATFORM_STATE as Record<string, PlatformState>)[slug];
  return fromState ?? "planned";
}

type PlatformBase = Omit<Platform, "status">;

/**
 * Order mirrors the Zernio reference: Twitter/X first, then TikTok, then
 * LinkedIn, then Bluesky, then the Meta surfaces (IG → FB → Threads),
 * then Pinterest. Drop the status-bucket sort — single grid, one order.
 */
const PLATFORMS_BASE: readonly PlatformBase[] = [
  {
    slug: "twitter",
    name: "Twitter / X",
    icon: "x-logo",
    tagline: "v2 API + chunked video upload",
    pitch:
      "OAuth 2.0 PKCE handled server-side. Up to four images, an MP4 video via chunked upload, reply chains, quote tweets — one POST surface for all of it.",
    detail:
      "v2 API · 280-grapheme tweets (t.co-aware) · 4 images OR 1 video OR 1 GIF · alt text best-effort via v1.1 metadata",
    videoSupport: true,
    carouselSupport: true,
    gotcha:
      "X retired the free posting tier in 2025 — Pay Per Use is the cheapest entry point. letmepost works on any tier with `tweet.write`.",
  },
  {
    slug: "tiktok",
    name: "TikTok",
    icon: "tiktok-logo",
    tagline: "Content Posting API · in App Review",
    pitch:
      "Content Posting API with OAuth 2.0 PKCE + push_by_file upload to the user's TikTok inbox. Publisher is built and ready; we're under App Review for the Direct Post scope. Connect is gated until approval — until then sandbox / audit accounts post privacy=SELF_ONLY.",
    detail:
      "Content Posting API · video uploads · OAuth PKCE · App Review in progress",
    videoSupport: true,
    carouselSupport: false,
    gotcha:
      "Reserved in the schema for v2. No production traffic flows yet; the route exists for SEO + roadmap visibility.",
  },
  {
    slug: "linkedin",
    name: "LinkedIn",
    icon: "linkedin-logo",
    tagline: "Versioned REST · the wedge platform",
    pitch:
      "LinkedIn sunset five API versions in six months from 2024–25. We pin the version header, monitor sunsets, and upgrade internally — your code keeps working when LinkedIn ships a breaking change at 2 a.m.",
    detail:
      "Versioned REST · 3,000-grapheme commentary · personal posts in v1 · org posts via Marketing Developer Platform (MDP)",
    videoSupport: false,
    carouselSupport: false,
    gotcha:
      "Org / Company Page posting requires MDP approval. v1 ships personal posting; org publishing lands in the next phase.",
  },
  {
    slug: "bluesky",
    name: "Bluesky",
    icon: "butterfly",
    tagline: "AT Proto · live for everyone today",
    pitch:
      "App-password connect, no OAuth review, no app gates. The AT Proto stack ships v1's most permissive on-ramp — sign in with an app password and the API is live.",
    detail:
      "AT Proto · 300-grapheme posts · 4 images or 1 video · video routes through the dedicated transcoding service automatically",
    videoSupport: true,
    carouselSupport: true,
  },
  {
    slug: "instagram",
    name: "Instagram",
    icon: "instagram-logo",
    tagline: "Meta Graph · IG Business via FB Login",
    pitch:
      "One Facebook OAuth grants both Pages and IG Business access. Single-image, single-video (Reels), or 2–10 mixed-media carousels. URL reachability — the canonical `OAuthException 2207052` — caught locally before upstream.",
    detail:
      "Meta Graph · 2,200-grapheme captions · JPEG-only photo path · 2–10 mixed-media carousels",
    videoSupport: true,
    carouselSupport: true,
    gotcha:
      "Connect via `/v1/accounts/connect/facebook`, not `/instagram` — one consent fans out to Pages + linked IG Business.",
  },
  {
    slug: "facebook",
    name: "Facebook Pages",
    icon: "facebook-logo",
    tagline: "Meta Graph · Pages + IG fan-out",
    pitch:
      "Facebook Login for Business. Text-only, single photo, multi-photo, or video posts to your Pages. The same OAuth grant lights up linked IG Business accounts in one step.",
    detail:
      "Meta Graph · text up to 63,206 chars · single video OR up to 10 photos · video posts via /videos endpoint",
    videoSupport: true,
    carouselSupport: true,
  },
  {
    slug: "tiktok",
    name: "TikTok",
    icon: "tiktok-logo",
    tagline: "Content Posting API · upload-inbox in v1",
    pitch:
      "OAuth 2.0 PKCE + push_by_file upload to the user's TikTok inbox. App-review for the Direct Post scope is in progress; until then, sandbox / audit accounts post privacy=SELF_ONLY and the user confirms publish in the TikTok app.",
    detail:
      "Content Posting API · MP4 / MOV / MPEG video · 4 GB push_by_file ceiling · privacy forced to SELF_ONLY on audit accounts",
    videoSupport: true,
    carouselSupport: false,
    gotcha:
      "App is in audit / sandbox state — uploads land in the user's TikTok inbox for manual publish. Direct Post unlocks once `video.publish` clears review.",
  },
  {
    slug: "threads",
    name: "Threads",
    icon: "threads-logo",
    tagline: "Meta Threads Graph API · 2–20 carousels",
    pitch:
      "Standalone OAuth at threads.net (not Facebook Login). Text, single image, single video, or a 2–20-child mixed-media carousel — Threads's two-step async publish is hidden from the caller.",
    detail:
      "Threads Graph API · 500-grapheme posts · 60-day token · containers expire after 24 h",
    videoSupport: true,
    carouselSupport: true,
  },
  {
    slug: "pinterest",
    name: "Pinterest",
    icon: "pinterest-logo",
    tagline: "v5 API · image + video pins",
    pitch:
      "Image pins go through `media_source.url` directly — single round-trip and the pin is live. Video pins run register-media → S3 multipart → poll → createPin transparently.",
    detail:
      "v5 API · image + video pins · cover image required for video · destination URL reachability checked locally",
    videoSupport: true,
    carouselSupport: false,
    gotcha:
      "Trial Access apps must point at the sandbox host. Production access requires Standard Access approval.",
  },
];

export const PLATFORMS: readonly Platform[] = PLATFORMS_BASE.map((p) => ({
  ...p,
  status: statusFor(p.slug),
}));

export type ApiSurface = {
  slug: string;
  name: string;
  /** Phosphor icon id (without the `ph:` prefix). */
  icon: string;
  /** Status — every API on this list is live unless marked otherwise. */
  status: PlatformStatus;
  /** One-liner shown next to the dropdown label. */
  tagline: string;
  /** Hero subhead on the API page. */
  pitch: string;
  /** Bullet shown on the page detail line. */
  detail: string;
};

export const APIS: readonly ApiSurface[] = [
  {
    slug: "publishing",
    name: "Publishing API",
    icon: "paper-plane-tilt",
    status: "live",
    tagline: "POST /v1/posts — text, media, schedule",
    pitch:
      "One POST endpoint, eight platforms. Idempotency keys on every write. Preflight validation before the upstream call. Schedule with `scheduledAt`; webhooks confirm publish.",
    detail:
      "POST /v1/posts · idempotency · preflight rules · scheduled posts · per-platform overrides",
  },
  {
    slug: "media",
    name: "Media API",
    icon: "image",
    status: "live",
    tagline: "POST /v1/media — multipart upload",
    pitch:
      "Upload bytes once, reference by `mediaId` on every post that uses them. Cuts publish-time latency, deduplicates assets across posts, and unlocks video on platforms (Bluesky, Twitter, Pinterest) where inline base64 doesn't scale.",
    detail:
      "POST /v1/media · multipart · S3-backed · scoped per-org · referenced from `media: [{ mediaId }]`",
  },
  {
    slug: "webhooks",
    name: "Webhooks",
    icon: "broadcast",
    status: "live",
    tagline: "HMAC-signed delivery for every state transition",
    pitch:
      "Subscribe once, receive `post.queued`, `post.published`, `post.failed`, `post.rejected`, `token.expiring`, `token.revoked`, `version.deprecated`. Every payload HMAC-signed with a per-endpoint secret you rotate.",
    detail:
      "POST /v1/webhook-endpoints · 8 event types · HMAC-SHA256 · exponential backoff · dead-letter inspection",
  },
];
