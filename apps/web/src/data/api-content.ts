/**
 * Per-surface marketing copy for /api/[slug] landing pages.
 *
 * Same shape as platform-content.ts so the [slug] template can share
 * most of its rendering with /platforms/[slug]. Surface-specific
 * sections (the webhook event catalog, the media upload pipeline)
 * live as optional fields and render conditionally.
 */

export interface ComparePoint {
  body: string;
}

export interface ContentTypePill {
  label: string;
  icon: string;
  note?: string;
}

export interface SurfaceStep {
  title: string;
  body: string;
}

export interface SurfaceFeature {
  icon: string;
  title: string;
  body: string;
}

export interface SurfaceFaq {
  q: string;
  a: string;
}

export interface SurfaceMargNote {
  tag: string;
  body: string;
}

export interface AlsoPill {
  body: string;
  href: string;
  label: string;
}

/** Webhooks-only: catalog of event types. */
export interface EventCatalogRow {
  name: string;
  desc: string;
  when: string;
  lifecycle?: string;
}

/** Webhooks-only: numbered delivery timeline. */
export interface DeliveryStep {
  body: string;
  when: string;
}

/** Media-only: upload-pipeline stages. */
export interface PipelineStage {
  label: string;
  code?: string;
  body: string;
}

export interface SurfaceContent {
  /** Endpoint pill shown above the h1. */
  badge: { method: string; path: string };

  /** Hero h1 fragments — `prefix <under>underlined</under> suffix`. */
  heroH1: { prefix: string; underlined: string; suffix?: string };
  heroSub: string;
  heroLede: string;
  reassurance?: string;
  miniCodeLang: "json" | "ts" | "bash";
  miniCode: string;

  vsHead: string;
  vsDirectTitle: string;
  vsDirect: ComparePoint[];
  vsLetmepost: ComparePoint[];
  costBanner?: { tone: "good" | "bad"; body: string };

  highlight?: { tone: "good" | "warn"; title: string; body: string };

  /** Capabilities pills shown after the highlight. */
  capabilitiesTitle: string;
  capabilitiesSubtitle: string;
  capabilities: ContentTypePill[];

  /** "How it works" step list. */
  stepsTitle: string;
  stepsSubtitle: string;
  steps: SurfaceStep[];

  featuresTitle: string;
  featuresSubtitle: string;
  features: SurfaceFeature[];
  /** Cross-link pill rendered under the features grid. */
  alsoPill?: AlsoPill;

  codeExample: {
    file: string;
    caption: string;
    lang: "ts" | "js" | "bash";
    code: string;
  };

  errorRef?: { title: string; body: string; href: string };

  faqSubtitle: string;
  faqs: SurfaceFaq[];

  /** Webhooks-only event catalog. */
  eventCatalog?: { title: string; subtitle: string; rows: EventCatalogRow[] };
  /** Webhooks-only delivery model. */
  delivery?: { title: string; subtitle: string; steps: DeliveryStep[] };
  /** Media-only upload pipeline. */
  pipeline?: { title: string; subtitle: string; stages: PipelineStage[] };

  finalCtaH2: string;
  finalCtaLede: string;
  finalCtaPrimaryLabel: string;
  finalCtaSecondaryLabel: string;
  finalCtaSecondaryHref: string;

  closeoutThanks: string;
  closeoutCodeLine: string;

  marg: SurfaceMargNote[];

  /** Nav-rail colophon override. */
  colophon: string;
}

const publishing: SurfaceContent = {
  badge: { method: "POST", path: "/v1/posts" },

  heroH1: { prefix: "One", underlined: "POST", suffix: "." },
  heroSub: "Eight platforms. Preflight before postflight.",
  heroLede:
    "The primary <b>letmepost</b> endpoint. Send text, media, or scheduled posts to one or many connected accounts in a single HTTP call. <b>80 preflight rules</b> run locally before the upstream platform is touched. <b>Idempotency keys</b> on every write. Per-target results so you never have to guess whether four succeeded and one didn't.",
  reassurance:
    'No credit card · 50 posts/mo free forever · <a href="https://docs.letmepost.dev/quickstart">90-second quickstart →</a>',
  miniCodeLang: "json",
  miniCode: `{
  "targets": [
    { "platform": "bluesky" },
    { "platform": "x" },
    { "platform": "pinterest" }
  ],
  "text": "Shipped multi-target publishing today.",
  "scheduledAt": "2026-06-15T19:00:00Z"
}`,

  vsHead: "Why one endpoint instead of eight?",
  vsDirectTitle: "Per-platform SDKs",
  vsDirect: [
    { body: "8 SDKs, 8 versions, 8 maintainers to keep up with" },
    { body: "8 different error shapes to unify in your code" },
    { body: "8 different auth dances to maintain" },
    { body: "5 LinkedIn sunsets to patch your code through" },
    { body: "No shared idempotency layer" },
    { body: "Postflight failures only, you find out after the call" },
  ],
  vsLetmepost: [
    { body: "One endpoint, one shape, one auth dance" },
    { body: "<b>One stable error envelope</b> across all platforms" },
    { body: "Idempotency keys handled in the middleware" },
    { body: "Platform versions pinned for you" },
    { body: "<b>80 preflight rules</b> run before the upstream call" },
    { body: "Per-target outcomes, never an ambiguous boolean" },
  ],
  costBanner: {
    tone: "good",
    body: "<b>One HTTP call publishes everywhere.</b> Idempotency-safe. Preflight-checked. Same shape Bluesky → LinkedIn.",
  },

  highlight: {
    tone: "good",
    title: "✓  Preflight before postflight",
    body: "Every documented constraint runs locally before the upstream platform sees the request: character counts, byte caps, media-format checks, audit-state validation, URN patterns, URL reachability. <b>You get the rule id and remediation hint, not an empty body / empty message mystery.</b>",
  },

  capabilitiesTitle: "CAPABILITIES",
  capabilitiesSubtitle: "what the endpoint can do",
  capabilities: [
    { label: "Text posts", icon: "text-aa" },
    { label: "Images", icon: "image" },
    { label: "Video", icon: "video-camera" },
    { label: "Carousels", icon: "frame-corners" },
    { label: "Scheduled", icon: "clock", note: "ISO 8601" },
    { label: "Reply chains", icon: "arrow-bend-up-left" },
    { label: "Quote posts", icon: "quotes" },
    { label: "Per-platform overrides", icon: "sliders-horizontal" },
  ],

  stepsTitle: "HOW IT WORKS",
  stepsSubtitle: "request lifecycle · ~150ms median",
  steps: [
    {
      title: "Validate the envelope",
      body: "Shape validation against the OpenAPI spec. Wrong type? <code>invalid_request</code> with the JSON path of the bad field. Median latency under 5ms.",
    },
    {
      title: "Run preflight rules",
      body: "~80 rules fire per request, scoped to the target platforms. Character counts, byte caps, media-format checks, audit-state validation. Failed preflight returns 422 with the rule id and a remediation hint <b>without ever touching the upstream platform</b>.",
    },
    {
      title: "Idempotency check",
      body: "If <code>Idempotency-Key</code> is present and we've seen it in the last 24h, return the cached response. If the body fingerprint differs, return <code>idempotency_conflict</code> (HTTP 409).",
    },
    {
      title: "Publish to each target in parallel",
      body: "One upstream call per target. Per-target outcome captured in the response envelope. Webhook <code>post.published</code> fires per-target. Median wall-clock under 2 seconds for a 3-target post.",
    },
  ],

  featuresTitle: "FEATURES",
  featuresSubtitle: "things the endpoint does that you don't have to build",
  features: [
    {
      icon: "check-square",
      title: "Preflight, not postflight",
      body: "Every documented platform constraint runs locally before the upstream call. Fails fast, fails loudly, fails with a doc URL.",
    },
    {
      icon: "shuffle",
      title: "Idempotency by default",
      body: "<code>Idempotency-Key</code> on every write. 24-hour replay window. Body-hash conflict detection on key reuse, surfaced as 409.",
    },
    {
      icon: "clock",
      title: "Scheduled posts",
      body: "<code>scheduledAt: ISO8601</code> queues a delayed job. Returns 202 instead of 201. Webhook <code>post.published</code> confirms the publish when it lands.",
    },
    {
      icon: "sliders-horizontal",
      title: "Per-platform overrides",
      body: "<code>pinterest.boardId</code>, <code>x.replyToTweetId</code>, <code>threads.replyToId</code>. Escape hatches without breaking the unified shape.",
    },
    {
      icon: "list-bullets",
      title: "Per-target outcomes",
      body: "Never an ambiguous boolean. Each target gets its own <code>status</code>, <code>url</code>, and (on failure) <code>error</code> sub-envelope. Iterate, log, retry per-target if needed.",
    },
    {
      icon: "key",
      title: "One auth shape",
      body: "Bearer-token <code>lmp_live_</code> or <code>lmp_test_</code> on every call. We hold the platform tokens, encrypted at rest, refreshed on the right schedule per platform.",
    },
  ],
  alsoPill: {
    body: "<b>Pair with the Media API for video</b> and large image uploads.",
    href: "/api/media",
    label: "Media API →",
  },

  codeExample: {
    file: "publish-multi.ts",
    caption: "multi-target publish with idempotency · typescript",
    lang: "ts",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

const result = await lmp.posts.create({
  targets: [
    { platform: 'bluesky',   accountId: 'acc_bsky_xyz' },
    { platform: 'x',         accountId: 'acc_x_xyz' },
    { platform: 'pinterest', accountId: 'acc_pin_xyz',
      // per-platform override — escape hatch without breaking the shape
      pinterest: { boardId: '934821023' } },
  ],
  text: 'Shipped multi-target publishing today.',
  media: [{ mediaId: 'med_01HXZ4N9...' }],
  // Idempotency-Key stamped automatically by the SDK
});

// Per-target outcomes — never an ambiguous boolean
for (const r of result.targets) {
  if (r.status === 'published') {
    console.log(r.platform, '→', r.url);
  } else if (r.status === 'failed') {
    console.error(r.platform, r.error.code, r.error.rule, r.error.docUrl);
  }
}`,
  },

  errorRef: {
    title: "Publishing API error reference",
    body: "11 stable error codes plus the 80 preflight-rule identifiers. Each has its own docs page with remediation guidance.",
    href: "https://docs.letmepost.dev/errors",
  },

  faqSubtitle: "about the publishing endpoint",
  faqs: [
    {
      q: "How does multi-target publishing count toward my quota?",
      a: "One <code>POST /v1/posts</code> = one quota unit, regardless of how many targets. Posting to 8 platforms in a single call counts as <b>1 post</b>, not 8.",
    },
    {
      q: "What happens if one target succeeds and another fails?",
      a: 'You get a 200 with a per-target outcome list. The succeeded targets are live, the failed ones have <code>status: "failed"</code> + a full <code>error</code> sub-envelope. Retry the failed targets independently.',
    },
    {
      q: "Is the Idempotency-Key required?",
      a: "No, but recommended. Without it, retry-storms can double-post. With it, replays within 24h return the cached response. The SDK stamps one automatically if you don't provide one.",
    },
    {
      q: "How do I schedule a post?",
      a: 'Add <code>scheduledAt: "2026-06-15T19:00:00Z"</code> (ISO 8601, UTC recommended). Returns 202 instead of 201. We fire <code>post.queued</code> immediately and <code>post.published</code> when it lands.',
    },
    {
      q: "Can I cancel a scheduled post?",
      a: "Yes. <code>DELETE /v1/posts/:id</code> while it's still in <code>scheduled</code> state. Returns 204. Cancellations fire a <code>post.canceled</code> webhook.",
    },
    {
      q: "How fast is the endpoint?",
      a: "Median request-to-response is ~150ms (preflight + idempotency check + accept). Wall-clock to publish is ~2s for a 3-target post, bound by upstream platforms.",
    },
    {
      q: "What's the rate limit?",
      a: "Per-org, not per-key. Burst of 100 requests in 10s, then 1,000/min sustained. Quota wall at your monthly cap. <code>429</code> responses carry <code>Retry-After</code>.",
    },
    {
      q: "Can I dry-run a request?",
      a: "Yes. <code>POST /v1/preflight</code> runs the rules without publishing. Same response envelope, same error codes. Useful for client-side validation before the actual write.",
    },
  ],

  finalCtaH2: "READY TO POST?",
  finalCtaLede:
    "Mint an API key. Send your first request. <b>Free during alpha</b> · self-host forever free.",
  finalCtaPrimaryLabel: "GET AN API KEY →",
  finalCtaSecondaryLabel: "READ THE REFERENCE",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/api-reference/posts/create",

  closeoutThanks: "* * * POST · ABSTRACTED · DONE * * *",
  closeoutCodeLine: "SURFACE · PUBLISHING · /v1/posts",

  marg: [
    {
      tag: "Endpoint",
      body: "<code>POST /v1/posts</code><br />Returns <b>201</b> on immediate publish, <b>202</b> on scheduled, <b>422</b> on preflight fail.",
    },
    {
      tag: "Auth",
      body: "<code>Authorization: Bearer lmp_live_…</code><br />Org-scoped. Profile-scoped via <code>X-LMP-Profile</code> header.",
    },
    {
      tag: "Idempotency",
      body: "<code>Idempotency-Key</code> header. 24h replay window. Body-hash conflict → 409 <code>idempotency_conflict</code>.",
    },
    {
      tag: "Rate limits",
      body: "100 req / 10s burst. 1,000 req / min sustained. <code>429</code> carries <code>Retry-After</code>.",
    },
    {
      tag: "Preflight",
      body: "80 rules. Each pure function, each tested, each has a docs page. Run them dry via <code>POST /v1/preflight</code>.",
    },
    {
      tag: "Scheduled",
      body: "ISO 8601 timestamp. <code>scheduledAt</code> in the future returns 202. Cancel via <code>DELETE /v1/posts/:id</code> while still scheduled.",
    },
  ],

  colophon:
    "The primary surface. <b>One POST. Eight platforms.</b> Preflight before postflight, idempotency on every write.",
};

const media: SurfaceContent = {
  badge: { method: "POST", path: "/v1/media" },

  heroH1: { prefix: "Upload", underlined: "once", suffix: "." },
  heroSub: "Reference everywhere.",
  heroLede:
    "Upload bytes once via <b>POST /v1/media</b>. Reference the returned <code>mediaId</code> from every post that uses it. Bytes move once, posts move many times. Required for video on every platform; recommended for any image you'll post more than once.",
  reassurance:
    'Multipart form-data · 8 MB images · 500 MB video · <a href="https://docs.letmepost.dev/api-reference/media/upload">API reference →</a>',
  miniCodeLang: "bash",
  miniCode: `curl -X POST https://api.letmepost.dev/v1/media \\
  -H "Authorization: Bearer $LMP_KEY" \\
  -F "file=@./photo.jpg" \\
  -F "kind=image"

# Returns 201 with { id: "med_01HXZ4N9..." }
# Reference that id from posts.create.`,

  vsHead: "Why upload once vs inline base64?",
  vsDirectTitle: "Inline base64",
  vsDirect: [
    { body: "Bytes re-uploaded on every multi-target post" },
    { body: "33% size overhead from base64 encoding" },
    { body: "<b>Doesn't work for video</b>, payloads exceed platform caps" },
    { body: "Slower publish wall-clock on every call" },
    { body: "No cross-platform variant generation" },
    { body: "No CDN-backed asset URLs you can reference elsewhere" },
  ],
  vsLetmepost: [
    { body: "Upload once, reference forever (up to retention)" },
    { body: "S3-backed multipart upload, no base64 overhead" },
    { body: "<b>Video uploads up to 500 MB</b>, transcoded per platform" },
    { body: "Publish wall-clock unchanged regardless of media size" },
    { body: "Per-platform variants generated automatically" },
    { body: "CDN URL returned for use in your own UI" },
  ],

  highlight: {
    tone: "good",
    title: "✓  Upload bytes once, post many times",
    body: "Bytes hit our S3 bucket once. Subsequent <code>POST /v1/posts</code> calls reference the <code>mediaId</code>. Multi-target posts share the same upload — Bluesky + X + Pinterest publishing the same photo move three platforms' worth of metadata but only one set of bytes.",
  },

  capabilitiesTitle: "SUPPORTED TYPES",
  capabilitiesSubtitle: "images, video, and the platform-specific variants we generate",
  capabilities: [
    { label: "JPEG / PNG / WebP", icon: "image", note: "up to 8 MB" },
    { label: "MP4 / MOV video", icon: "video-camera", note: "up to 500 MB" },
    { label: "GIF", icon: "image-square" },
    { label: "HEIC → JPEG", icon: "arrows-clockwise", note: "auto-converted" },
    { label: "Per-platform variants", icon: "frame-corners", note: "auto-generated" },
    { label: "Alt text", icon: "text-aa" },
  ],

  stepsTitle: "UPLOAD PIPELINE",
  stepsSubtitle: "multipart → s3 → cdn · seconds, not minutes",
  steps: [
    {
      title: "Client uploads",
      body: "<code>POST /v1/media</code> with multipart form-data. Single request for files ≤ 100 MB. Larger files use resumable upload with chunked PUTs.",
    },
    {
      title: "S3 + virus scan",
      body: "Bytes hit our S3 bucket, ClamAV scans on ingress, content-type sniffed from magic bytes (not the upload's <code>Content-Type</code> header).",
    },
    {
      title: "Variants generated",
      body: "Per-platform variants encoded ahead of time. Bluesky 976 KB-capped JPEGs, Pinterest cover frames, IG Reels H.264. Variants come from the source on demand.",
    },
    {
      title: "Reference on publish",
      body: "Pass <code>mediaId</code> to <code>POST /v1/posts</code>. We pick the right variant per target. Bytes move once, posts fan out.",
    },
  ],

  featuresTitle: "FEATURES",
  featuresSubtitle: "things you don't have to build",
  features: [
    {
      icon: "upload-simple",
      title: "One upload, many posts",
      body: "Upload bytes once via <code>POST /v1/media</code>. Reference the returned id from <code>media: [{ mediaId }]</code> on every post that uses it.",
    },
    {
      icon: "frame-corners",
      title: "Per-platform variants",
      body: "We pre-encode platform-specific variants (Bluesky JPEG-cap, IG Reels H.264, Pinterest video covers) so the publish path stays fast.",
    },
    {
      icon: "shield-check",
      title: "Virus scan on ingress",
      body: "ClamAV scans every upload before it lands in our active bucket. Failed scans return <code>media_rejected_security</code> with the threat name.",
    },
    {
      icon: "video-camera",
      title: "Video transcode pipeline",
      body: "MP4 → per-platform H.264 variants. Pinterest cover frames extracted automatically. Threads container creation handled at publish time.",
    },
    {
      icon: "clock-counter-clockwise",
      title: "30-day retention free",
      body: "Default 30 days. <code>media.expiring</code> webhook fires 7 days before GC. Pro extends to 90, Business to 365.",
    },
    {
      icon: "link-simple",
      title: "CDN-backed asset URLs",
      body: "Every uploaded asset has a CDN URL — useful for preview UIs in your own dashboard, drag-and-drop reordering, etc.",
    },
  ],
  alsoPill: {
    body: "<b>Reference your uploaded media from</b> the Publishing API.",
    href: "/api/publishing",
    label: "Publishing API →",
  },

  codeExample: {
    file: "upload-and-publish.ts",
    caption: "upload then reference · typescript",
    lang: "ts",
    code: `import { Letmepost } from '@letmepost/sdk';
import { readFileSync } from 'node:fs';

const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

// Step 1: upload the bytes (multipart). Bytes only move once.
const media = await lmp.media.upload({
  file: readFileSync('./photo.jpg'),
  kind: 'image',
  altText: 'Receipt-themed landing page',
});
console.log('Got mediaId:', media.id); // 'med_01HXZ4N9...'

// Step 2: reference it from any post that uses it
const result = await lmp.posts.create({
  targets: [
    { platform: 'bluesky',   accountId: 'acc_bsky_xyz' },
    { platform: 'x',         accountId: 'acc_x_xyz' },
    { platform: 'pinterest', accountId: 'acc_pin_xyz' },
  ],
  text: 'Same photo, three platforms, one upload.',
  media: [{ mediaId: media.id }],
});

// Same uploaded bytes are referenced by all three posts.
// Per-platform variants picked automatically.`,
  },

  faqSubtitle: "about uploading media",
  faqs: [
    {
      q: "Can I skip the Media API and inline-base64 small images?",
      a: 'Yes. For images under ~1 MB, inline <code>media: [{ data: "base64...", kind: "image" }]</code> works fine. For video and larger images, use the Media API — inline base64 will hit platform-specific payload caps.',
    },
    {
      q: "How long are uploads kept?",
      a: "Default 30 days, free. <code>media.expiring</code> webhook fires 7 days before garbage collection. Pro extends to 90 days, Business to 365.",
    },
    {
      q: "Does the Media API count toward my post quota?",
      a: "No. Uploads are free and unlimited. Only successful publishes meter against your quota.",
    },
    {
      q: "Can I reference the same mediaId on multiple posts?",
      a: "Yes. Reference forever (up to retention). Multi-target posts share the same upload automatically, bytes only move once.",
    },
    {
      q: "What size limits apply?",
      a: "Per upload: 8 MB image, 500 MB video. Platform constraints (e.g. Bluesky's 976 KB per image cap) are enforced at publish time, not upload time, so you can upload high-res once and we re-encode per platform.",
    },
    {
      q: "How does video transcoding work?",
      a: "Video uploads are stored as-is plus per-platform variants (H.264 MP4 at platform-specific bitrate caps). Pinterest video pins also get an auto-generated cover frame.",
    },
    {
      q: "Can I delete an upload?",
      a: "Yes. <code>DELETE /v1/media/:id</code>. Posts that already published to upstream platforms keep working (those bytes left our system); future references return 404.",
    },
  ],

  finalCtaH2: "READY TO UPLOAD?",
  finalCtaLede:
    "Bytes once. Posts many. <b>Free uploads</b>, unlimited references, 30-day retention on the free tier.",
  finalCtaPrimaryLabel: "GET AN API KEY →",
  finalCtaSecondaryLabel: "READ THE REFERENCE",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/api-reference/media/upload",

  closeoutThanks: "* * * BYTES ONCE · POSTS MANY * * *",
  closeoutCodeLine: "SURFACE · MEDIA · /v1/media",

  marg: [
    {
      tag: "Endpoint",
      body: "<code>POST /v1/media</code><br />Multipart form-data. Returns <b>201</b> with <code>{ id, kind, expiresAt }</code>.",
    },
    {
      tag: "Limits",
      body: "8 MB image, 500 MB video, 50 MB GIF. Files larger than 100 MB use resumable chunked PUT.",
    },
    {
      tag: "Retention",
      body: "30 days free, 90 days Pro, 365 days Business. <code>media.expiring</code> webhook fires 7 days before GC.",
    },
    {
      tag: "Variants",
      body: "Per-platform encoding precomputed on upload. Picked automatically at publish time by the slug on each target.",
    },
    {
      tag: "Cost",
      body: "<b>Uploads are free.</b> Don't meter against post quota. Bandwidth + storage absorbed by letmepost.",
    },
    {
      tag: "Security",
      body: "ClamAV scan on ingress. Malicious uploads return <code>media_rejected_security</code> with the detected threat name.",
    },
  ],

  colophon: "<b>POST once.</b> Reference forever. Variants pre-generated.",
};

const webhooks: SurfaceContent = {
  badge: { method: "POST", path: "/v1/webhook-endpoints" },

  heroH1: { prefix: "Stop", underlined: "polling", suffix: "." },
  heroSub: "HMAC-signed delivery for every state transition.",
  heroLede:
    "Subscribe to <b>8 lifecycle events</b> with one POST. Webhooks land on your endpoint within median 800ms of each transition. <b>HMAC-SHA256 signatures</b> with per-endpoint secrets. <b>Replay-safe</b> with explicit retry budget and a dead-letter queue. Same envelope shape as the HTTP API.",
  reassurance:
    '8 event types · HMAC-SHA256 · exponential retry · <a href="https://docs.letmepost.dev/api-reference/webhook-endpoints/create">API reference →</a>',
  miniCodeLang: "json",
  miniCode: `{
  "url": "https://your-app.example/lmp-webhook",
  "events": [
    "post.queued",
    "post.published",
    "post.failed",
    "token.expiring"
  ]
}`,

  vsHead: "Why webhooks vs polling?",
  vsDirectTitle: "Polling GET /v1/posts/:id",
  vsDirect: [
    { body: "You eat your own rate limit just to check status" },
    { body: "Latency = whatever your poll interval is" },
    { body: "Wastes compute on the 99% of polls that are no-change" },
    { body: "No signal for token expiry, version deprecations, quota walls" },
    { body: "You write the backoff logic yourself" },
    { body: "Multi-target posts: N status calls per publish" },
  ],
  vsLetmepost: [
    { body: "Push delivery, median <b>800ms</b> from event to your endpoint" },
    { body: "Zero polling overhead, zero rate-limit hits" },
    { body: "HMAC-signed payloads with per-endpoint secret rotation" },
    { body: "Lifecycle, token, version, quota events all on one channel" },
    { body: "Exponential retry built in, then DLQ as last resort" },
    { body: "One event per state transition, no duplicate-busy work" },
  ],

  highlight: {
    tone: "good",
    title: "✓  Same envelope as the HTTP API",
    body: "Webhook payloads carry the same fields you'd get from a synchronous response: <code>id</code>, <code>status</code>, <code>error</code>, <code>request_id</code>. <b>You can grep webhooks the same way you grep logs.</b>",
  },

  capabilitiesTitle: "EVENT TYPES",
  capabilitiesSubtitle: "8 lifecycle signals across post + auth + platform",
  capabilities: [
    { label: "post.queued", icon: "circle" },
    { label: "post.validated", icon: "check-circle" },
    { label: "post.published", icon: "broadcast" },
    { label: "post.failed", icon: "warning-circle" },
    { label: "post.rejected", icon: "x-circle" },
    { label: "token.expiring", icon: "key" },
    { label: "token.revoked", icon: "lock-key-open" },
    { label: "version.deprecated", icon: "git-branch" },
  ],

  stepsTitle: "DELIVERY MODEL",
  stepsSubtitle: "how a webhook lands · retries on failure · dlq as last resort",
  steps: [
    {
      title: "Event fires",
      body: "Payload built, signature computed with your per-endpoint secret. Stamped with <code>X-LMP-Signature</code> + <code>X-LMP-Timestamp</code> headers. Median latency before first POST: <b>~50ms</b>.",
    },
    {
      title: "Delivery attempt 1",
      body: "We POST to your endpoint. Success = HTTP 2xx within 10s. Anything else is a failure: timeout, 4xx, 5xx, connection refused.",
    },
    {
      title: "Retry on failure",
      body: "Exponential backoff: 30s, 2min, 10min, 30min, 2h, 6h. <b>Six attempts over ~9 hours</b>. Each carries the same payload, signature, and request id.",
    },
    {
      title: "DLQ after exhaustion",
      body: "Six failed attempts: delivery moves to your endpoint's dead-letter queue. Inspect via the dashboard or <code>POST /v1/webhook-endpoints/:id/replay/:event_id</code>.",
    },
  ],

  featuresTitle: "FEATURES",
  featuresSubtitle: "things you don't have to build",
  features: [
    {
      icon: "list-bullets",
      title: "8 event types",
      body: "<code>post.queued</code>, <code>post.validated</code>, <code>post.published</code>, <code>post.failed</code>, <code>post.rejected</code>, <code>token.expiring</code>, <code>token.revoked</code>, <code>version.deprecated</code>.",
    },
    {
      icon: "fingerprint",
      title: "HMAC-SHA256 signatures",
      body: "Per-endpoint secret. Signature computed over <code>timestamp.body</code>. Verify with <code>timingSafeEqual</code> to avoid timing attacks. Replay-window enforcement built in.",
    },
    {
      icon: "arrows-clockwise",
      title: "Exponential retry",
      body: "Six attempts over ~9h on failure: 30s, 2min, 10min, 30min, 2h, 6h. Each retry carries the same payload + signature.",
    },
    {
      icon: "archive-box",
      title: "Dead-letter queue",
      body: "After retries exhaust, delivery lands in DLQ. <b>7-day inspection on Pro, 30-day on Business.</b> Replay any event manually.",
    },
    {
      icon: "key",
      title: "Per-endpoint secret rotation",
      body: "<code>POST /v1/webhook-endpoints/:id/rotate-secret</code>. Old secret stays valid for <b>12 hours</b> so you can roll your handler without dropping deliveries.",
    },
    {
      icon: "shield-check",
      title: "Verify helper in the SDK",
      body: "The TS + Python SDKs ship a <code>verifyWebhook()</code> helper that checks signature + timestamp window. Drop into Express, Fastify, FastAPI in two lines.",
    },
  ],
  alsoPill: {
    body: "<b>Webhooks fire on every Publishing API write.</b> Pair them up.",
    href: "/api/publishing",
    label: "Publishing API →",
  },

  codeExample: {
    file: "webhook-handler.ts",
    caption: "verify a webhook · typescript",
    lang: "ts",
    code: `import { createHmac, timingSafeEqual } from 'node:crypto';

// Verify HMAC-SHA256 over \`timestamp.body\` against the X-LMP-Signature
// header. Use timingSafeEqual to avoid timing-attack signal leakage.

function verifyLetmepostWebhook(req, secret) {
  const sig = req.headers['x-lmp-signature'] as string;
  const ts  = req.headers['x-lmp-timestamp'] as string;

  // Replay window — reject anything older than 5 min
  const age = Math.abs(Date.now() / 1000 - parseInt(ts, 10));
  if (age > 300) return false;

  const expected = createHmac('sha256', secret)
    .update(\`\${ts}.\${req.rawBody}\`)
    .digest('hex');

  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

app.post('/lmp-webhook', (req, res) => {
  if (!verifyLetmepostWebhook(req, process.env.LMP_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  const event = JSON.parse(req.rawBody);
  switch (event.type) {
    case 'post.published': /* update your UI */ break;
    case 'post.failed':    /* notify the user */ break;
    case 'token.expiring': /* prompt re-auth */  break;
  }
  res.status(200).end();
});`,
  },

  errorRef: {
    title: "Webhook delivery reference",
    body: "Every event payload schema, every header, every retry rule. Plus the verify-helper source.",
    href: "https://docs.letmepost.dev/api-reference/webhook-endpoints",
  },

  faqSubtitle: "about webhook delivery",
  faqs: [
    {
      q: "How fast do webhooks arrive?",
      a: "Median <b>800ms</b> from event firing to your endpoint receiving the POST. P95 under 3s. Long-tail bounded by upstream platform latencies (e.g. Meta video transcoding).",
    },
    {
      q: "What if my endpoint is down?",
      a: "We retry on exponential backoff: 30s, 2min, 10min, 30min, 2h, 6h. Six attempts over ~9h. Then the delivery lands in DLQ where you can replay it manually.",
    },
    {
      q: "Do I need a separate endpoint per event?",
      a: "No. One endpoint can subscribe to all 8 events. You dispatch on <code>event.type</code> in your handler. But you <i>can</i> subscribe multiple endpoints if you want to route events to different services.",
    },
    {
      q: "How do I rotate a webhook secret?",
      a: "<code>POST /v1/webhook-endpoints/:id/rotate-secret</code>. Old secret stays valid for <b>12 hours</b> after rotation so you can roll your handler without dropping deliveries.",
    },
    {
      q: "Are webhooks counted against my quota?",
      a: "No. Webhook deliveries are free, unlimited, and don't consume any post-quota units. We only meter writes you initiate.",
    },
    {
      q: "Can I replay events from the past?",
      a: "Yes on Pro and Business: replay any event from the last 7 days (Pro) or 30 days (Business) via the dashboard or <code>POST /v1/webhook-endpoints/:id/replay</code>.",
    },
    {
      q: "How big can payloads get?",
      a: "Typical payload is 2–4 KB. Maximum 16 KB. Embedded raw upstream responses are truncated past the cap; the full body is always available via <code>GET /v1/posts/:id</code>.",
    },
  ],

  finalCtaH2: "READY TO SUBSCRIBE?",
  finalCtaLede:
    "One POST. Eight event types. <b>Stop polling, start listening.</b> Free during alpha, free forever on self-host.",
  finalCtaPrimaryLabel: "GET AN API KEY →",
  finalCtaSecondaryLabel: "READ THE REFERENCE",
  finalCtaSecondaryHref:
    "https://docs.letmepost.dev/api-reference/webhook-endpoints/create",

  closeoutThanks: "* * * PUSH · NOT POLL * * *",
  closeoutCodeLine: "SURFACE · WEBHOOKS · /v1/webhook-endpoints",

  marg: [
    {
      tag: "Endpoint",
      body: "<code>POST /v1/webhook-endpoints</code><br />Returns <b>201</b> with the endpoint id + the secret (shown once).",
    },
    {
      tag: "Signature",
      body: "<code>X-LMP-Signature</code> = HMAC-SHA256(secret, <code>timestamp.body</code>). <code>X-LMP-Timestamp</code> for replay-window enforcement (default 5 min).",
    },
    {
      tag: "Retries",
      body: "30s, 2min, 10min, 30min, 2h, 6h. Six attempts. DLQ after.",
    },
    {
      tag: "DLQ",
      body: "7-day inspection on Pro, 30-day on Business. Replay via dashboard or API.",
    },
    {
      tag: "Verify helper",
      body: "SDKs ship a one-liner: <code>lmp.webhooks.verify(req, secret)</code>. TS + Python today, Go in flight.",
    },
    {
      tag: "Cost",
      body: "<b>Free, unlimited.</b> Webhook deliveries don't count against quota.",
    },
  ],

  colophon: "Push, not poll. <b>8 lifecycle signals, one secret.</b>",
};

export const API_CONTENT: Record<string, SurfaceContent> = {
  publishing,
  media,
  webhooks,
};
