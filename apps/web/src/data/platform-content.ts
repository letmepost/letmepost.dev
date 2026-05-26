/**
 * Per-platform marketing copy for the /platforms/[slug] landing pages.
 *
 * Lives separately from `platforms.ts` (which is canonical product data
 * mirrored from the backend Platform enum) so the marketing surface can
 * change copy without churning the data file the API + dashboard read.
 *
 * Shape is consistent across platforms so the template can render the
 * same sections in the same order. Some fields are optional — when a
 * platform skips one (e.g. `costBanner`), the section either falls back
 * to a sensible default or doesn't render at all.
 */

export interface ComparePoint {
  /** Mark up `<b>...</b>` for emphasis. Plain HTML allowed. */
  body: string;
}

export interface ContentTypePill {
  label: string;
  /** Phosphor icon name (without `ph:`). */
  icon: string;
  note?: string;
}

export interface PlatformStep {
  title: string;
  /** HTML allowed for inline emphasis + code spans. */
  body: string;
}

export interface PlatformFeature {
  /** Phosphor icon name without `ph:`. */
  icon: string;
  title: string;
  body: string;
}

export interface PlatformFaq {
  q: string;
  /** HTML allowed for emphasis + code + anchors. */
  a: string;
}

export interface PlatformMargNote {
  tag: string;
  /** HTML allowed. */
  body: string;
}

export interface PlatformContent {
  /**
   * Hero h1 fragments rendered as:
   *   `{before} <icon /> {Platform} {after}`
   *   `<break>`
   *   `<accent>{emphasize}</accent>`
   *
   * The platform name + its icon are injected inline by the template
   * from `PLATFORMS` so this object only owns the surrounding copy.
   */
  heroH1: { before: string; after: string; emphasize: string };
  /** Sub-headline (accent-colored). Optional — the new heroH1 carries
   *  the value claim inline; older content kept this for the previous
   *  layout. Left in the type for back-compat. */
  heroSub?: string;
  /** Lede paragraph. HTML allowed. */
  heroLede: string;
  /** Reassurance line under the CTAs. HTML allowed. */
  reassurance?: string;
  /** Mini code preview shown under the hero. JSON body. */
  miniCode: string;

  /** VS comparison header text ("Why letmepost vs X direct?"). */
  vsHead: string;
  /** Left-column bullets (the "direct" approach — marked with ✗). */
  vsDirect: ComparePoint[];
  /** Right-column bullets (letmepost — marked with ✓). */
  vsLetmepost: ComparePoint[];
  /** Optional banner under the compare grid. */
  costBanner?: { tone: "good" | "bad"; body: string };

  /** Optional highlight block (green callout) after the comparison. */
  highlight?: { tone: "good" | "warn"; title: string; body: string };

  /** Playground / try-it block. */
  playground: {
    steps: string[];
    /** HTML body inside the playground card. */
    body: string;
    cta: { href: string; label: string };
    result: string;
    resultCaption: string;
  };

  /** Content-type pill row. */
  contentTypes: ContentTypePill[];

  /** "How it works" 3-step list. */
  steps: PlatformStep[];

  /** Feature grid (4 cards). */
  features: PlatformFeature[];

  /** Big code example. */
  codeExample: {
    file: string;
    caption: string;
    /** Raw TS — rendered as-is in a <pre>. No syntax highlighting beyond
     *  what the receipt's existing token classes provide. */
    code: string;
  };

  /** Optional "API error reference" link card. */
  errorRef?: { title: string; body: string; href: string };

  /** FAQ subtitle + entries. */
  faqSubtitle: string;
  faqs: PlatformFaq[];

  /** Final CTA section. */
  finalCtaH2: string;
  finalCtaLede: string;
  finalCtaPrimaryLabel: string;
  finalCtaSecondaryLabel: string;
  finalCtaSecondaryHref: string;

  /** Closeout customization. */
  closeoutThanks: string;
  closeoutCodeLine: string;

  /** Right-rail notes specific to this platform. */
  marg: PlatformMargNote[];

  /** Nav-rail colophon override. */
  colophon: string;
}

// ──────────────────────────────────────────────────────────
// Content
// ──────────────────────────────────────────────────────────

const bluesky: PlatformContent = {
  heroH1: { before: "Ship Your", after: "Integration", emphasize: "In Minutes, Not Weeks." },
  heroSub: "App-password. Not OAuth.",
  heroLede:
    "No developer-portal queue. No third-party OAuth review. No demo videos. <b>letmepost</b> gives you a single endpoint to publish text, images, video, reply chains, and quote posts. AT Proto handled, graphemes counted, facets resolved, federated PDSes supported.",
  reassurance:
    'Live · day-zero platform · <a href="https://docs.letmepost.dev/platforms/bluesky">read the docs →</a>',
  miniCode: `{
  "targets": [{ "platform": "bluesky" }],
  "accountId": "acc_bsky_xyz",
  "text": "Hello from letmepost. 300 graphemes safe."
}`,

  vsHead: "Why letmepost vs AT Proto direct?",
  vsDirect: [
    { body: "You write the PDS resolver yourself" },
    { body: "You implement the facet parser for <code>@handles</code> and <code>#tags</code>" },
    { body: "You handle the <b>graphemes AND bytes</b> dual cap" },
    { body: "You build the video transcoding pipeline" },
    { body: "You manage app-password rotation per account" },
    { body: "You hand-roll federation for custom PDSes" },
  ],
  vsLetmepost: [
    { body: "One endpoint, same shape as all other platforms" },
    { body: "Facets auto-detected and resolved before publish" },
    { body: "<b>80 preflight rules</b> including grapheme + byte caps" },
    { body: "Video routed through our transcoding service" },
    { body: "App passwords stored encrypted, rotated transparently" },
    { body: "Federation handled per-account" },
  ],
  costBanner: {
    tone: "good",
    body: "<b>Bluesky was our day-zero platform.</b> The reason letmepost shipped in four weeks instead of six months.",
  },

  highlight: {
    tone: "good",
    title: "✓  No OAuth review required",
    body: "AT Proto lets any user create an app password and authenticate with it directly. No third-party OAuth approval, no Meta-style App Review, no demo videos. <b>The API is live the moment your user pastes an app password into our dashboard.</b>",
  },

  playground: {
    steps: ["Connect", "Configure", "Execute"],
    body: "Generate an <b>app password</b> in Bluesky → Settings → Privacy &amp; Security → App passwords. Paste into our dashboard. Post immediately.",
    cta: { href: "https://dashboard.letmepost.dev/connect", label: "CONNECT BLUESKY →" },
    result: "Live in ~12 seconds.",
    resultCaption: "NO OAUTH DANCE",
  },

  contentTypes: [
    { label: "Text", icon: "text-aa", note: "300 graphemes" },
    { label: "Photos", icon: "image", note: "up to 4" },
    { label: "Video", icon: "video-camera", note: "single MP4" },
    { label: "Reply chains", icon: "arrow-bend-up-left" },
    { label: "Quote posts", icon: "quotes" },
  ],

  steps: [
    {
      title: "Get your API key",
      body: "Sign up at <code>dashboard.letmepost.dev</code>. 30 seconds. No credit card. Free tier covers 50 posts/mo across all platforms.",
    },
    {
      title: "Connect a Bluesky account",
      body: "Paste an <b>app password</b> from your Bluesky settings. No OAuth dance, no review queue, no app submission. Stored AES-256-GCM encrypted at rest.",
    },
    {
      title: "Send a post",
      body: 'One <code>POST /v1/posts</code> with <code>platform: "bluesky"</code>. We resolve facets, count graphemes + bytes, push to your PDS, fire <code>post.published</code> within 3 seconds.',
    },
  ],

  features: [
    {
      icon: "check-square",
      title: "No review queue",
      body: "AT Proto needs no developer-portal approval. You connect with an app password and post immediately. Most permissive on-ramp in v1.",
    },
    {
      icon: "ruler",
      title: "Grapheme + byte caps",
      body: "Bluesky enforces both 300 graphemes AND 3,000 UTF-8 bytes. We check both with <code>Intl.Segmenter</code>, exactly the way AT Proto does.",
    },
    {
      icon: "tag",
      title: "Facets auto-detected",
      body: "<code>@handle.bsky.social</code> and <code>#hashtag</code> facets parsed and resolved to DIDs before publish. Unresolvable handles fail loudly.",
    },
    {
      icon: "tree-structure",
      title: "Custom PDS support",
      body: "Federation is real on Bluesky. Per-account PDS config. Default is bsky.network. Bring your own PDS, we route correctly.",
    },
  ],

  codeExample: {
    file: "publish-bluesky.ts",
    caption: "post to bluesky · typescript",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

const result = await lmp.posts.create({
  targets: [{ platform: 'bluesky', accountId: 'acc_bsky_xyz' }],
  text: 'Just shipped a feature with letmepost. 🎉 #buildinpublic',
  media: [{
    type: 'image',
    url: 'https://your-image.jpg',
    alt: 'Receipt-themed landing page',
  }],
});

for (const r of result.targets) {
  if (r.status === 'published') {
    console.log('AT URI:', r.url);
    // at://did:plc:abc.../app.bsky.feed.post/3lqz...
  }
}`,
  },

  errorRef: {
    title: "Bluesky API error reference",
    body: "AT Proto error codes mapped to letmepost's stable envelope. Plus the 12 Bluesky-specific preflight rules.",
    href: "https://docs.letmepost.dev/errors/platforms/bluesky",
  },

  faqSubtitle: "about publishing to bluesky",
  faqs: [
    {
      q: "Does Bluesky require OAuth?",
      a: "No. AT Proto uses <b>app passwords</b> instead of OAuth. Generate one in Bluesky → Settings → Privacy &amp; Security → App passwords. Paste into our dashboard. That's the entire connect flow.",
    },
    {
      q: "What about Bluesky's grapheme + byte limits?",
      a: 'Both enforced locally. 300 graphemes max, 3,000 UTF-8 bytes max. Whichever caps first wins. A wall of emoji can blow the byte limit before the grapheme limit. Use our <a href="https://docs.letmepost.dev/tools/bluesky-grapheme-counter">grapheme counter</a> to check.',
    },
    {
      q: "Can I post to a custom Bluesky PDS?",
      a: "Yes. Per-account PDS config. Default is bsky.network. If your user is on a custom PDS, we route to it correctly.",
    },
    {
      q: "Does video work on Bluesky?",
      a: "Yes. Single MP4 per post. Routed through our transcoding service automatically — Bluesky's video upload has format constraints we normalize for you.",
    },
    {
      q: "Can I create reply chains and quote posts?",
      a: 'Yes. Pass <code>inReplyTo: "at://..."</code> for replies, <code>quote: "at://..."</code> for quote posts. Same as a regular post otherwise.',
    },
    {
      q: "What does Bluesky cost?",
      a: "Free for users, free for us, free for you. AT Proto doesn't gate API access. Your only cost is letmepost's flat per-org rate.",
    },
  ],

  finalCtaH2: "READY TO PUBLISH TO BLUESKY?",
  finalCtaLede:
    "The platform that needs no review queue. Sign up, paste an app password, send your first post in <b>under two minutes</b>.",
  finalCtaPrimaryLabel: "START FREE →",
  finalCtaSecondaryLabel: "READ DOCS",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/platforms/bluesky",

  closeoutThanks: "* * * AT PROTO · DAY ZERO * * *",
  closeoutCodeLine: "PLAT · BLUESKY · AT PROTO · LIVE",

  marg: [
    {
      tag: "App password",
      body: "Generate in Bluesky → Settings → Privacy &amp; Security → App passwords. Paste once, stored encrypted. <b>No OAuth flow.</b>",
    },
    {
      tag: "Limits",
      body: "300 graphemes AND 3,000 UTF-8 bytes. 4 images per post. 976 KB each. Single MP4. All enforced locally before publish.",
    },
    {
      tag: "Federation",
      body: "Per-account PDS. Default is <code>bsky.network</code>. Custom PDSes routed automatically based on the account's DID.",
    },
    {
      tag: "Webhook timing",
      body: "<code>post.published</code> typically fires within <b>2–3 seconds</b>. Slowest measured is 4.1s during PDS load spikes.",
    },
    {
      tag: "Self-host",
      body: 'Self-hosters point directly at any PDS (yours or bsky.network). No "BYO app" needed — AT Proto has no OAuth app to register.',
    },
  ],

  colophon: "<b>AT Proto.</b> Open. Federated. The easiest platform to ship to. Day-zero for letmepost.",
};

const x: PlatformContent = {
  heroH1: { before: "Ship Your", after: "Integration", emphasize: "In Minutes, Not Weeks." },
  heroSub: "Skip the $100 Basic tier.",
  heroLede:
    "Stop wrestling with X's API pricing and OAuth complexity. <b>letmepost</b> gives you a single, simple endpoint to publish tweets, threads, images, and video. We handle OAuth 2.0 PKCE, rate limits, t.co URL collapse, and every API version change.",
  reassurance: 'Live · v2 API · <a href="https://docs.letmepost.dev/platforms/twitter">read the docs →</a>',
  miniCode: `{
  "targets": [{ "platform": "twitter" }],
  "accountId": "acc_x_xyz",
  "text": "Shipped with letmepost. 280 chars weighted."
}`,

  vsHead: "Why letmepost vs X API direct?",
  vsDirect: [
    { body: "You pay $100/mo minimum for X API Basic to post" },
    { body: "You implement OAuth 2.0 PKCE + token refresh" },
    { body: "You wrestle with t.co URL collapse (every URL = 23 chars)" },
    { body: "You handle chunked video upload across 3 endpoints" },
    { body: "You track which API version still works this month" },
    { body: "You build retry logic for X's flaky rate limits" },
  ],
  vsLetmepost: [
    { body: "<b>Pay-Per-Use tier works.</b> No $100 Basic required for letmepost users" },
    { body: "OAuth 2.0 PKCE handled server-side, tokens encrypted at rest" },
    { body: "Weighted character counter ships <code>twitter-text</code>'s actual range table" },
    { body: "Single <code>POST /v1/posts</code> with media id, chunked upload abstracted" },
    { body: "We pin the version header, monitor sunsets, upgrade internally" },
    { body: "Idempotency-Key handles retries safely" },
  ],
  costBanner: {
    tone: "bad",
    body: "<b>X retired the free posting tier in 2025.</b> letmepost works on the Pay-Per-Use tier today — no Basic subscription needed.",
  },

  highlight: {
    tone: "warn",
    title: "⚠  No X API Basic tier required",
    body: "X removed free posting in 2025 and gates write access behind a $100/mo Basic plan. <b>letmepost users post via our app's Pay-Per-Use credit pool</b> — no separate X subscription. The cost difference covers letmepost's flat fee multiple times over.",
  },

  playground: {
    steps: ["Connect", "Configure", "Execute"],
    body: "OAuth 2.0 PKCE handled in the browser. Click connect, authorize on x.com, you're back in the dashboard with a working account.",
    cta: { href: "https://dashboard.letmepost.dev/connect", label: "CONNECT X →" },
    result: "Posting in ~30 seconds.",
    resultCaption: "PKCE HANDLED",
  },

  contentTypes: [
    { label: "Tweet", icon: "text-aa", note: "280 weighted" },
    { label: "Photos", icon: "image", note: "up to 4" },
    { label: "Video", icon: "video-camera", note: "chunked MP4" },
    { label: "Threads", icon: "list-bullets" },
    { label: "Quote tweets", icon: "quotes" },
  ],

  steps: [
    {
      title: "Get your API key",
      body: "Sign up at <code>dashboard.letmepost.dev</code>. 30 seconds. No credit card. No X developer account required from you.",
    },
    {
      title: "Connect an X account",
      body: "OAuth 2.0 PKCE flow handled by letmepost. Click connect, authorize on x.com, you're done. Access + refresh tokens encrypted at rest.",
    },
    {
      title: "Send a tweet",
      body: 'One <code>POST /v1/posts</code> with <code>platform: "twitter"</code>. We compute weighted chars, push to X v2, fire <code>post.published</code> with the tweet URL.',
    },
  ],

  features: [
    {
      icon: "currency-dollar",
      title: "Skip the $100 tier",
      body: "letmepost users post via our app's credit pool. You don't pay X's $100/mo Basic plan to send a tweet through us.",
    },
    {
      icon: "ruler",
      title: "Weighted char counter",
      body: "twitter-text range tables baked in. CJK and emoji count as 2, URLs collapse to t.co (23 chars). Same math X uses server-side.",
    },
    {
      icon: "video-camera",
      title: "Chunked video, abstracted",
      body: "X video upload is 3 endpoints with FINALIZE/STATUS dance. We handle the whole sequence and surface a single status.",
    },
    {
      icon: "git-branch",
      title: "Version pin",
      body: "X has rotated v1.1 → v2 → various sub-versions. We pin the working one, track sunsets, upgrade transparently.",
    },
  ],

  codeExample: {
    file: "publish-x.ts",
    caption: "post a tweet · typescript",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

// A scheduled tweet with media + reply target
const result = await lmp.posts.create({
  targets: [{ platform: 'twitter', accountId: 'acc_x_xyz' }],
  text: 'Tools that ship are tools that get used. https://letmepost.dev',
  media: [{ type: 'image', url: 'https://your-image.jpg' }],
  scheduledAt: '2026-06-01T15:00:00Z',
});

for (const r of result.targets) {
  if (r.status === 'queued') {
    console.log('Scheduled. Tweet URL on publish:', r.scheduledUrl);
  }
}`,
  },

  errorRef: {
    title: "X API error reference",
    body: "X v2 error codes mapped to letmepost's stable envelope. Plus the 14 X-specific preflight rules (weighted chars, media counts, audit states).",
    href: "https://docs.letmepost.dev/errors/platforms/twitter",
  },

  faqSubtitle: "code-review questions about X posting",
  faqs: [
    {
      q: "Do I need an X developer account?",
      a: "No. letmepost uses its own X developer app. You connect via our hosted OAuth flow, no developer-portal access required from you.",
    },
    {
      q: "How does the $100 Basic tier issue work?",
      a: "X gated write access behind $100/mo in 2025. letmepost users post via our app's Pay-Per-Use credit pool — you don't pay X's tier fee. The credits are bundled into letmepost's flat per-org rate.",
    },
    {
      q: "What about the weighted character count?",
      a: 'X uses a range-table formula where CJK = 2, emoji = 2, URLs = 23 chars (t.co length). We ship the actual <code>twitter-text</code> library, so our counter agrees with X server-side. <a href="https://docs.letmepost.dev/tools/x-character-counter">Counter tool here</a>.',
    },
    {
      q: "Can I post threads?",
      a: 'Yes. Pass an array of <code>text</code> entries: <code>{ texts: ["First", "Second", "Third"] }</code>. We thread them automatically via reply_to_tweet_id.',
    },
    {
      q: "What about videos?",
      a: "Single MP4 per tweet. Chunked upload abstracted into a single SDK call. We handle the INIT/APPEND/FINALIZE dance and the STATUS poll.",
    },
    {
      q: "Rate limits?",
      a: "letmepost's per-org limits apply. X's tweet rate limits are tracked per-account; we surface them as <code>rate_limited</code> errors with <code>Retry-After</code> — never silent.",
    },
  ],

  finalCtaH2: "READY TO PUBLISH TO X?",
  finalCtaLede:
    "Skip the developer portal. Skip the $100 Basic tier. Skip the OAuth 2.0 PKCE implementation. <b>Connect in 30 seconds, post in one minute.</b>",
  finalCtaPrimaryLabel: "START FREE →",
  finalCtaSecondaryLabel: "READ DOCS",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/platforms/twitter",

  closeoutThanks: "* * * X · v2 · WEIGHTED * * *",
  closeoutCodeLine: "PLAT · X · v2 · LIVE",

  marg: [
    {
      tag: "OAuth flow",
      body: "OAuth 2.0 PKCE handled in the browser. No client secret in your code. Tokens stored AES-256-GCM encrypted.",
    },
    {
      tag: "Limits",
      body: "280 weighted chars (CJK = 2, emoji = 2, URLs = 23 via t.co). 4 images OR 1 MP4 video. Threads up to 25 tweets.",
    },
    {
      tag: "Version pin",
      body: "We pin v2 of the X API. <code>GET /v1/platform-versions</code> exposes the current pin. Sunset notifications via <code>version.deprecated</code> webhook.",
    },
    {
      tag: "Webhook timing",
      body: "<code>post.published</code> fires within <b>1–2 seconds</b> for text-only, 5–15s for video (transcode dependent).",
    },
  ],

  colophon: "<b>X v2 API.</b> Weighted chars. Chunked video. Pay-Per-Use, not Basic.",
};

const pinterest: PlatformContent = {
  heroH1: { before: "Ship Your", after: "Integration", emphasize: "In Minutes, Not Weeks." },
  heroSub: "v5 API. Pins with one POST.",
  heroLede:
    "Image and video pins through the v5 API. <b>letmepost</b> handles board lookup, destination-URL reachability checks, video cover thumbnails, and the register-media + S3 multipart + poll dance that Pinterest demands for video.",
  reassurance: 'Live · v5 API · <a href="https://docs.letmepost.dev/platforms/pinterest">read the docs →</a>',
  miniCode: `{
  "targets": [{ "platform": "pinterest" }],
  "accountId": "acc_pin_xyz",
  "text": "Built with letmepost.",
  "options": { "boardId": "1234567890" }
}`,

  vsHead: "Why letmepost vs Pinterest v5 direct?",
  vsDirect: [
    { body: "You apply for Standard Access (4-week review)" },
    { body: "You implement the register-media → S3 multipart → poll dance for video" },
    { body: "You build cover-thumbnail extraction for video pins" },
    { body: "You validate destination URLs are reachable before publish" },
    { body: "You handle the per-user board lookup + cache" },
    { body: "You parse Pinterest's nested error envelopes" },
  ],
  vsLetmepost: [
    { body: "Our reviewed app covers Standard Access for hosted users" },
    { body: "Video upload abstracted to a single <code>mediaId</code> reference" },
    { body: "Cover thumbnail auto-extracted at upload time" },
    { body: "URL reachability checked in preflight; never a silent platform reject" },
    { body: "Board IDs cached per-account; one lookup per session" },
    { body: "Errors normalized to the stable letmepost envelope" },
  ],

  highlight: {
    tone: "good",
    title: "✓  Image AND video pins, one shape",
    body: "Both image and video pins go through the same <code>POST /v1/posts</code>. Video pins automatically extract a cover thumbnail and run Pinterest's register-media + S3 multipart + status poll sequence. You get one webhook when the pin is live.",
  },

  playground: {
    steps: ["Connect", "Configure", "Execute"],
    body: "OAuth on pinterest.com, select boards, you're back in the dashboard. Sandbox accounts work for testing; Standard Access for production.",
    cta: { href: "https://dashboard.letmepost.dev/connect", label: "CONNECT PINTEREST →" },
    result: "First pin in ~45 seconds.",
    resultCaption: "BOARDS LOADED",
  },

  contentTypes: [
    { label: "Image pin", icon: "image", note: "JPG, PNG, WebP" },
    { label: "Video pin", icon: "video-camera", note: "MP4 ≤ 2GB" },
    { label: "Description", icon: "text-aa", note: "500 chars" },
    { label: "Destination URL", icon: "link-simple" },
    { label: "Scheduled pins", icon: "clock" },
  ],

  steps: [
    {
      title: "Get your API key",
      body: "Sign up at <code>dashboard.letmepost.dev</code>. Free tier covers 50 pins/mo.",
    },
    {
      title: "Connect a Pinterest account",
      body: "OAuth on pinterest.com, grant board access, you're done. We cache your board list for ~5 minutes per session.",
    },
    {
      title: "Pin an image (or video)",
      body: 'One <code>POST /v1/posts</code> with <code>platform: "pinterest"</code> and <code>options.boardId</code>. We upload media, set cover, push to Pinterest, fire <code>post.published</code>.',
    },
  ],

  features: [
    {
      icon: "image",
      title: "Image + video, one shape",
      body: "Both pin types through the same endpoint. Video pins run register-media → S3 multipart → poll → createPin transparently.",
    },
    {
      icon: "frame-corners",
      title: "Auto cover thumbnail",
      body: "Video pins need a cover. We extract one from the source video at upload time; you can override with your own.",
    },
    {
      icon: "link-simple",
      title: "URL reachability check",
      body: "Destination URLs validated in preflight. Pinterest silently rejects unreachable URLs; we surface them before the API call.",
    },
    {
      icon: "list-bullets",
      title: "Board lookup cached",
      body: "Board IDs cached per-account, refreshed on connect or explicit invalidation. One lookup per session, not per pin.",
    },
  ],

  codeExample: {
    file: "publish-pinterest.ts",
    caption: "pin an image · typescript",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

const result = await lmp.posts.create({
  targets: [{ platform: 'pinterest', accountId: 'acc_pin_xyz' }],
  text: 'Receipt-themed landing pages, hand-tuned typography.',
  media: [{ type: 'image', url: 'https://your-image.jpg' }],
  options: {
    pinterest: {
      boardId: '1234567890',
      destinationUrl: 'https://letmepost.dev',
    },
  },
});

for (const r of result.targets) {
  if (r.status === 'published') {
    console.log('Pin URL:', r.url);
  }
}`,
  },

  faqSubtitle: "about publishing to pinterest",
  faqs: [
    {
      q: "Do I need a Pinterest developer account?",
      a: "No. letmepost runs the developer app. You connect via OAuth on pinterest.com.",
    },
    {
      q: "What's Standard Access vs Trial Access?",
      a: "Trial = sandbox-only (test pins don't appear on the public site). Standard = production. Our hosted app already has Standard Access; self-host users apply for their own.",
    },
    {
      q: "How do video pins work?",
      a: "Same <code>POST /v1/posts</code> with a video media id. We run Pinterest's register-media + S3 multipart + status poll. Cover thumbnail extracted automatically.",
    },
    {
      q: "Can I schedule pins?",
      a: "Yes. Add <code>scheduledAt: ISO8601</code>. We publish at the wall-clock target. Scheduled pins count against your quota when they publish, not when scheduled.",
    },
    {
      q: "What about destination URL validation?",
      a: "We do an HTTP HEAD on the destination URL before pinning. If it returns 4xx/5xx, you get a preflight error with <code>pinterest.url.destination_unreachable</code>. Pinterest would silently drop the pin otherwise.",
    },
    {
      q: "How many pins per day?",
      a: "Pinterest's per-user limit is ~25 pins/day for new accounts, higher for established ones. We surface their <code>X-RateLimit</code> headers; you get structured 429s, not silent drops.",
    },
  ],

  finalCtaH2: "READY TO PUBLISH TO PINTEREST?",
  finalCtaLede:
    "Skip the register-media dance. Skip the board cache. Skip the URL reachability check. <b>Pin in one POST.</b>",
  finalCtaPrimaryLabel: "START FREE →",
  finalCtaSecondaryLabel: "READ DOCS",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/platforms/pinterest",

  closeoutThanks: "* * * v5 API · STANDARD ACCESS * * *",
  closeoutCodeLine: "PLAT · PINTEREST · v5 · LIVE",

  marg: [
    {
      tag: "OAuth",
      body: "OAuth on pinterest.com. Token + refresh handled by us. Board read scope requested by default.",
    },
    {
      tag: "Limits",
      body: "500-char description. Image pins JPG/PNG/WebP. Video pins MP4 ≤ 2GB ≤ 15 min. ~25 pins/day per new user.",
    },
    {
      tag: "Boards",
      body: "Board list cached per-account. <code>POST /v1/accounts/:id/boards/refresh</code> forces a re-fetch.",
    },
    {
      tag: "Webhook timing",
      body: "Image pins: <b>2–4 seconds</b>. Video pins: <b>20–90 seconds</b> depending on duration (Pinterest processing time).",
    },
    {
      tag: "Self-host",
      body: "Self-hosters apply for their own Pinterest Standard Access (4-week review) and use their own credentials.",
    },
  ],

  colophon: "<b>Pinterest v5.</b> Image + video pins. Standard Access covered.",
};

// Below: shorter content for in-review / planned platforms — still
// substantive but without claiming live behavior we can't demonstrate.

const linkedin: PlatformContent = {
  heroH1: { before: "Ship Your", after: "Integration", emphasize: "In Minutes, Not Weeks." },
  heroSub: "Version pinned. Sunsets monitored.",
  heroLede:
    "LinkedIn sunset five API versions in six months from 2024–25, breaking n8n, Zapier, Make, and every Postiz install. <b>letmepost</b> pins the version header, tracks deprecations, upgrades internally — your code keeps working when LinkedIn ships a breaking change at 2 a.m.",
  reassurance:
    'In review · MDP submitted · <a href="https://docs.letmepost.dev/platforms/linkedin">read the docs →</a>',
  miniCode: `{
  "targets": [{ "platform": "linkedin" }],
  "accountId": "acc_li_xyz",
  "text": "Shipped via letmepost. Version-pinned.",
  "options": { "visibility": "PUBLIC" }
}`,

  vsHead: "Why letmepost vs LinkedIn REST direct?",
  vsDirect: [
    { body: "You track version sunsets weekly (5 in 6 months in 2024–25)" },
    { body: "You implement URN encoding for every share (<code>urn:li:share:...</code>)" },
    { body: "You apply for Marketing Developer Platform (12-week review)" },
    { body: "You hand-roll the audit-state error parser" },
    { body: "You manage org-vs-personal posting branches" },
    { body: "You handle MDP-gated permissions on every endpoint" },
  ],
  vsLetmepost: [
    { body: "Version header pinned in one config value; we own deprecations" },
    { body: "<code>version.deprecated</code> webhook fires before sunset" },
    { body: "URN encoding handled, error envelope normalized" },
    { body: "Our MDP review covers hosted users; self-host applies their own" },
    { body: "Personal posts in v1; org via MDP — same endpoint" },
    { body: "Audit-state errors mapped to stable preflight rules" },
  ],

  highlight: {
    tone: "warn",
    title: "⚠  Five API versions sunset in six months",
    body: "LinkedIn shipped breaking version changes <b>5 times in 6 months</b> from late 2024 through mid 2025. Every existing integration (Postiz, n8n, Zapier, Make, Pabbly) broke. letmepost users got <code>version.deprecated</code> webhooks days ahead and zero downtime.",
  },

  playground: {
    steps: ["Connect", "Configure", "Execute"],
    body: "OAuth on linkedin.com. Personal posts work today (in review). Org posts unlock once our MDP review clears — self-host users can BYO MDP entry today.",
    cta: { href: "https://dashboard.letmepost.dev/connect", label: "CONNECT LINKEDIN →" },
    result: "Approval-gated.",
    resultCaption: "MDP IN REVIEW · DAY 12 / ~84",
  },

  contentTypes: [
    { label: "Share post", icon: "text-aa", note: "3,000 graphemes" },
    { label: "Image", icon: "image" },
    { label: "Video", icon: "video-camera", note: "MP4" },
    { label: "Personal vs Org", icon: "users-three" },
    { label: "Scheduled", icon: "clock" },
  ],

  steps: [
    { title: "Get your API key", body: "Sign up at <code>dashboard.letmepost.dev</code>." },
    {
      title: "Connect a LinkedIn account",
      body: "OAuth on linkedin.com. We request the minimum scope set. Token + refresh stored encrypted.",
    },
    {
      title: "Publish a share",
      body: 'One <code>POST /v1/posts</code> with <code>platform: "linkedin"</code>. Personal commentary is live the day approval clears.',
    },
  ],

  features: [
    {
      icon: "git-branch",
      title: "Version pin + sunset tracking",
      body: "We pin the version header in a single config. The <code>version.deprecated</code> webhook fires when LinkedIn announces a sunset, days before it lands.",
    },
    {
      icon: "key",
      title: "URN encoding handled",
      body: "<code>urn:li:share:...</code> formatting is one of LinkedIn's silent failure modes. We percent-encode correctly, fail loudly on malformed URNs.",
    },
    {
      icon: "shield-check",
      title: "MDP-aware error surface",
      body: "If a token is missing an MDP permission, the error envelope says so — not a generic 403. Remediation hint points at the exact scope.",
    },
    {
      icon: "buildings",
      title: "Personal + org, one shape",
      body: "Same endpoint for personal and organization posts. Org publishing unlocks once MDP review clears.",
    },
  ],

  codeExample: {
    file: "publish-linkedin.ts",
    caption: "publish a share · typescript",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

const result = await lmp.posts.create({
  targets: [{ platform: 'linkedin', accountId: 'acc_li_xyz' }],
  text: 'Just published a 3,000-grapheme deep-dive on API versioning.',
  options: {
    linkedin: {
      visibility: 'PUBLIC',
      // For org posts, add: organizationUrn: 'urn:li:organization:12345'
    },
  },
});`,
  },

  faqSubtitle: "about linkedin posting",
  faqs: [
    {
      q: "When does LinkedIn go live on letmepost?",
      a: "Personal posting flips live the day our MDP review clears (typically 8–12 weeks). Org publishing requires the full MDP grant. Self-host with your own MDP entry to use it today.",
    },
    {
      q: "What about the version churn?",
      a: 'We pin the version header in one config value. <code>GET /v1/platform-versions</code> shows the current pin. The <code>version.deprecated</code> webhook fires before sunset, with the next pin in the payload.',
    },
    {
      q: "Can I post to a Company Page?",
      a: "Yes, once your MDP grant covers org posting. Pass <code>organizationUrn: \"urn:li:organization:...\"</code>. Self-host with your own MDP is the fastest path.",
    },
    {
      q: "What's URN encoding?",
      a: 'LinkedIn IDs look like <code>urn:li:share:7234567890</code>. The colons need percent-encoding in URLs (<code>urn%3Ali%3Ashare%3A...</code>). We handle this; the docs page has a counter tool.',
    },
    {
      q: "Does my company need its own MDP grant?",
      a: "For org-level publishing, yes — eventually. Personal posting via our shared OAuth is the day-one path.",
    },
  ],

  finalCtaH2: "READY FOR LINKEDIN PUBLISHING?",
  finalCtaLede:
    "Personal commentary live the day MDP clears. Self-host with your own MDP entry to publish today. <b>Either way, the same one POST.</b>",
  finalCtaPrimaryLabel: "START FREE →",
  finalCtaSecondaryLabel: "READ DOCS",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/platforms/linkedin",

  closeoutThanks: "* * * VERSIONED REST · PINNED * * *",
  closeoutCodeLine: "PLAT · LINKEDIN · MDP IN REVIEW",

  marg: [
    {
      tag: "Status",
      body: "Publisher shipped. <b>MDP review in flight.</b> Personal posts flip live on approval; org posts behind the full MDP grant.",
    },
    {
      tag: "Version pin",
      body: "Single config value. Sunset notifications via <code>version.deprecated</code> webhook before deprecation lands.",
    },
    {
      tag: "Limits",
      body: "3,000-grapheme commentary. Image + video share posts. Org-level reactions/comments out of v1.",
    },
    {
      tag: "URN encoding",
      body: 'LinkedIn IDs require percent-encoded URNs. We handle this; <a href="https://docs.letmepost.dev/tools/linkedin-urn-encoder-decoder">tool also available</a>.',
    },
    {
      tag: "Self-host",
      body: "Self-host users register their own MDP entry and use it today. No waiting on our queue.",
    },
  ],

  colophon: "<b>LinkedIn versioned REST.</b> The wedge platform. The reason letmepost exists.",
};

const threads: PlatformContent = {
  heroH1: { before: "Ship Your", after: "Integration", emphasize: "In Minutes, Not Weeks." },
  heroSub: "Threads Graph. 2–20 carousels.",
  heroLede:
    "Threads has its own OAuth (not Facebook Login) and its own quirky two-step async publish. <b>letmepost</b> abstracts both: standalone OAuth handled, container creation + finalize hidden from the caller, mixed-media carousels treated as a single POST.",
  reassurance:
    'In review · Threads Graph · <a href="https://docs.letmepost.dev/platforms/threads">read the docs →</a>',
  miniCode: `{
  "targets": [{ "platform": "threads" }],
  "accountId": "acc_th_xyz",
  "text": "Hello Threads. From letmepost."
}`,

  vsHead: "Why letmepost vs Threads Graph direct?",
  vsDirect: [
    { body: "Threads has its own OAuth at threads.net (not Facebook Login)" },
    { body: "You implement the two-step async publish (create container → finalize)" },
    { body: "You poll the container status for media-bearing posts" },
    { body: "You build carousel child handling for 2–20 children" },
    { body: "You wrestle with 60-day token expiry" },
    { body: "Containers expire after 24h, you handle re-creation" },
  ],
  vsLetmepost: [
    { body: "Standalone Threads OAuth handled in the browser" },
    { body: "Two-step publish abstracted into one POST" },
    { body: "Container status polled internally; you get a single webhook" },
    { body: "Carousels with 2–20 mixed-media children as one call" },
    { body: "Token refresh runs on a 7-day-before-expiry schedule" },
    { body: "Container TTL tracked; we recreate on next publish if expired" },
  ],

  highlight: {
    tone: "good",
    title: "✓  Standalone OAuth, not Facebook Login",
    body: "Threads has its own developer portal and its own OAuth flow at <code>threads.net</code>. Connecting a Threads account does NOT also connect Facebook or Instagram. <b>One platform, one credential, one consent.</b>",
  },

  playground: {
    steps: ["Connect", "Configure", "Execute"],
    body: "Threads OAuth on threads.net. Standalone, not bundled with Facebook. Live the day Meta App Review clears for this surface.",
    cta: { href: "https://dashboard.letmepost.dev/connect", label: "CONNECT THREADS →" },
    result: "Approval-gated.",
    resultCaption: "META REVIEW · DAY 24 / ~56",
  },

  contentTypes: [
    { label: "Text post", icon: "text-aa", note: "500 graphemes" },
    { label: "Image", icon: "image" },
    { label: "Video", icon: "video-camera" },
    { label: "Carousel", icon: "frame-corners", note: "2–20 mixed" },
    { label: "Reply", icon: "arrow-bend-up-left" },
  ],

  steps: [
    { title: "Get your API key", body: "Sign up at <code>dashboard.letmepost.dev</code>." },
    {
      title: "Connect a Threads account",
      body: "Standalone OAuth at threads.net. <b>Not</b> Facebook Login. Token + refresh stored encrypted.",
    },
    {
      title: "Publish a thread",
      body: 'One <code>POST /v1/posts</code> with <code>platform: "threads"</code>. We create the container, finalize, fire the webhook when it lands.',
    },
  ],

  features: [
    {
      icon: "arrows-clockwise",
      title: "Two-step publish abstracted",
      body: "Threads requires create-container + finalize for media posts. We run the dance, poll status, fire one <code>post.published</code> webhook.",
    },
    {
      icon: "frame-corners",
      title: "2–20 mixed-media carousels",
      body: "Carousel children can mix images and video. Pass an array of <code>mediaId</code> references; we handle the per-child container creation.",
    },
    {
      icon: "key",
      title: "60-day token, auto-refreshed",
      body: "Threads tokens expire in 60 days. We refresh on a 7-day pre-expiry schedule. <code>token.expiring</code> webhook fires 5 days before, just in case.",
    },
    {
      icon: "clock-countdown",
      title: "Container TTL tracking",
      body: "Containers expire after 24h. We track the TTL; if you publish to a stale container, we recreate transparently. No silent loss.",
    },
  ],

  codeExample: {
    file: "publish-threads.ts",
    caption: "publish a carousel · typescript",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

const result = await lmp.posts.create({
  targets: [{ platform: 'threads', accountId: 'acc_th_xyz' }],
  text: 'A 3-photo carousel via letmepost. One POST.',
  media: [
    { type: 'image', mediaId: 'med_001' },
    { type: 'image', mediaId: 'med_002' },
    { type: 'image', mediaId: 'med_003' },
  ],
});`,
  },

  faqSubtitle: "about threads publishing",
  faqs: [
    {
      q: "When does Threads go live?",
      a: "Publisher is shipped, waiting on Meta App Review for the Threads surface. Typical timeline 4–8 weeks. Self-host with your own Meta app to use it today.",
    },
    {
      q: "Does Threads use Facebook Login?",
      a: "No. Threads has its own standalone OAuth at threads.net. Connecting Threads does NOT connect Instagram or Facebook.",
    },
    {
      q: "How do carousels work?",
      a: 'Pass an array of <code>mediaId</code> references (2–20 children, mixed image + video allowed). We create per-child containers and finalize the parent.',
    },
    {
      q: "What about reply chains?",
      a: 'Pass <code>inReplyTo: "<threads-post-id>"</code>. The reply is published as a top-level thread connected to the parent.',
    },
    {
      q: "Token expiry?",
      a: "60 days. We refresh 7 days before expiry. <code>token.expiring</code> webhook fires 5 days before — your audit logs catch this either way.",
    },
  ],

  finalCtaH2: "READY FOR THREADS?",
  finalCtaLede:
    "Standalone OAuth, two-step publish, 2–20 carousels — all abstracted into one POST. <b>Live the day Meta approval clears.</b>",
  finalCtaPrimaryLabel: "START FREE →",
  finalCtaSecondaryLabel: "READ DOCS",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/platforms/threads",

  closeoutThanks: "* * * THREADS GRAPH · STANDALONE * * *",
  closeoutCodeLine: "PLAT · THREADS · META REVIEW",

  marg: [
    {
      tag: "OAuth",
      body: "Standalone Threads OAuth on threads.net. <b>Not</b> Facebook Login. One platform per credential.",
    },
    {
      tag: "Limits",
      body: "500-grapheme posts. Image, video, or 2–20-child carousels (mixed media OK).",
    },
    {
      tag: "Tokens",
      body: "60-day expiry. We refresh 7 days early. <code>token.expiring</code> webhook fires 5 days before.",
    },
    {
      tag: "Containers",
      body: "Threads containers expire after 24h. We track TTL and recreate transparently.",
    },
    {
      tag: "Self-host",
      body: "BYO Meta App with Threads surface enabled to skip our review queue. Same publisher code.",
    },
  ],

  colophon: "<b>Threads Graph.</b> Standalone OAuth. 2–20 carousels. Two-step abstracted.",
};

const instagram: PlatformContent = {
  heroH1: { before: "Ship Your", after: "Integration", emphasize: "In Minutes, Not Weeks." },
  heroSub: "Through our reviewed Meta app.",
  heroLede:
    "<b>Meta App Review is the single biggest reason small teams cannot ship a social publishing API.</b> Eleven weeks, three rejections, four re-shot demo videos. We did that once. Connect via our reviewed Meta app and publish through it. <a href='/blog/why-we-ate-meta-app-review'>Read the postmortem →</a>",
  reassurance:
    'In review · Meta App Review · <a href="https://docs.letmepost.dev/platforms/instagram">read the docs →</a>',
  miniCode: `{
  "targets": [{ "platform": "instagram" }],
  "accountId": "acc_ig_xyz",
  "text": "Reel via letmepost.",
  "media": [{ "mediaId": "med_reel_…" }]
}`,

  vsHead: "Why letmepost vs Meta Graph direct?",
  vsDirect: [
    { body: "You file Meta App Review (8–12 weeks across IG + FB + Threads)" },
    { body: "You record screen-recordings for every Advanced Access permission" },
    { body: "You complete Business Verification (5–15 days separately)" },
    { body: "You wrestle with OAuthException 2207052 for URL reachability" },
    { body: "You implement IG Business via Facebook Login fan-out" },
    { body: "You handle the 2-step publish (create container → finalize)" },
  ],
  vsLetmepost: [
    { body: "Our reviewed Meta app covers hosted users; you publish through it" },
    { body: "Connect via Facebook Login for Business; lights up Pages + IG" },
    { body: "URL reachability checked in preflight; never a silent 2207052" },
    { body: "Container creation + finalize abstracted to one POST" },
    { body: "Reels + carousels through the same endpoint" },
    { body: "Self-host with your own Meta app to skip the queue entirely" },
  ],
  costBanner: {
    tone: "good",
    body: "<b>You don't go through Meta App Review.</b> We did. Eleven weeks of paperwork, demo videos, and contradictory reviewer notes. Once. For everyone.",
  },

  highlight: {
    tone: "good",
    title: "✓  Meta App Review absorbed",
    body: "Our hosted Meta app covers Instagram, Facebook Pages, and Threads through a single shared review. <b>You inherit that work.</b> Self-hosters can BYO Meta app if they need their own reviewer-of-record.",
  },

  playground: {
    steps: ["Connect", "Configure", "Execute"],
    body: "Facebook Login for Business. <b>One consent grants Pages + IG Business + Threads access.</b> Live the day Meta approval clears for hosted users.",
    cta: { href: "https://dashboard.letmepost.dev/connect", label: "CONNECT META →" },
    result: "Approval-gated.",
    resultCaption: "META REVIEW · DAY 24 / ~56",
  },

  contentTypes: [
    { label: "Caption", icon: "text-aa", note: "2,200 chars" },
    { label: "Photo", icon: "image", note: "JPEG" },
    { label: "Reel", icon: "video-camera", note: "MP4 ≤ 90s" },
    { label: "Carousel", icon: "frame-corners", note: "2–10 mixed" },
    { label: "Scheduled", icon: "clock" },
  ],

  steps: [
    { title: "Get your API key", body: "Sign up at <code>dashboard.letmepost.dev</code>." },
    {
      title: "Connect via Facebook Login",
      body: "<b>One OAuth grant.</b> Lights up Pages + IG Business + Threads in a single consent. IG Business account required.",
    },
    {
      title: "Post a Reel (or carousel)",
      body: 'One <code>POST /v1/posts</code> with <code>platform: "instagram"</code>. We create the container, finalize, fire <code>post.published</code> when IG accepts.',
    },
  ],

  features: [
    {
      icon: "check-circle",
      title: "Meta App Review absorbed",
      body: "Our reviewed app covers IG + FB + Threads in one grant. You inherit weeks of paperwork, demo videos, and Business Verification.",
    },
    {
      icon: "users-four",
      title: "FB Login fan-out",
      body: "One OAuth consent grants Pages, IG Business, and Threads. Per-platform tokens generated server-side; you reference an accountId.",
    },
    {
      icon: "link-simple",
      title: "URL reachability preflight",
      body: "IG silently rejects media URLs that aren't reachable from their servers (OAuthException 2207052). We HEAD-check before publish.",
    },
    {
      icon: "frame-corners",
      title: "2–10 mixed-media carousels",
      body: "Carousel children can mix photos and Reels. Pass an array of mediaIds; we create per-child containers and finalize the parent.",
    },
  ],

  codeExample: {
    file: "publish-instagram.ts",
    caption: "post a reel · typescript",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

const result = await lmp.posts.create({
  targets: [{ platform: 'instagram', accountId: 'acc_ig_xyz' }],
  text: 'New Reel via letmepost. #buildinpublic',
  media: [{ type: 'video', mediaId: 'med_reel_xyz' }],
  options: {
    instagram: {
      kind: 'reel',
      coverImageUrl: 'https://your-thumbnail.jpg',
    },
  },
});`,
  },

  errorRef: {
    title: "Meta Graph error reference",
    body: "Every OAuthException + Graph error code mapped to letmepost's stable envelope. Plus 18 IG-specific preflight rules.",
    href: "https://docs.letmepost.dev/errors/platforms/instagram",
  },

  faqSubtitle: "about meta app review &amp; ig publishing",
  faqs: [
    {
      q: "When does Instagram go live?",
      a: 'Publisher shipped; in Meta App Review. Typical 8–12 weeks. <a href="/blog/why-we-ate-meta-app-review">Read the postmortem</a> for what that process looks like. Self-host with your own Meta app to use it today.',
    },
    {
      q: "Do I need to file Meta App Review?",
      a: 'No for hosted users — you publish through our reviewed app. Yes for self-host users who want their own reviewer-of-record. The config switch is <code>LMP_META_APP_MODE=byo</code>.',
    },
    {
      q: "What's OAuthException 2207052?",
      a: 'Instagram silently rejects media URLs that aren\'t reachable from their servers. We HEAD-check every media URL in preflight and surface <code>instagram.media.url_reachable</code> before Meta sees the request.',
    },
    {
      q: "Can I post Stories?",
      a: 'No. Stories require a separate Meta surface that\'s not v1. Reels, feed posts, and carousels are supported.',
    },
    {
      q: "Does it work for personal IG accounts?",
      a: 'No. Meta requires an Instagram Business or Creator account linked to a Facebook Page. The connect flow rejects personal accounts.',
    },
    {
      q: "What about Threads?",
      a: 'Threads has a <b>standalone OAuth</b> at threads.net, not Facebook Login. <a href="/platforms/threads">See the Threads page</a>.',
    },
  ],

  finalCtaH2: "READY FOR INSTAGRAM?",
  finalCtaLede:
    "Connect now, queue posts now, publish the day Meta approval clears. Or self-host with your own Meta app — <b>that surface is live today</b>.",
  finalCtaPrimaryLabel: "START FREE →",
  finalCtaSecondaryLabel: "READ DOCS",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/platforms/instagram",

  closeoutThanks: "* * * META APP REVIEW · ABSORBED * * *",
  closeoutCodeLine: "PLAT · INSTAGRAM · META REVIEW",

  marg: [
    {
      tag: "Connect",
      body: "Facebook Login for Business. <b>One consent</b> grants Pages + IG Business + Threads. IG Business account required.",
    },
    {
      tag: "Limits",
      body: "2,200-char captions. JPEG-only photos. Reels ≤ 90s. Carousels 2–10 mixed children.",
    },
    {
      tag: "URL reachability",
      body: "IG rejects unreachable media URLs silently (OAuthException 2207052). We HEAD-check in preflight.",
    },
    {
      tag: "App Review",
      body: '<b>We do it. You inherit it.</b> Self-host with <code>LMP_META_APP_MODE=byo</code> for your own grant.',
    },
    {
      tag: "Webhook timing",
      body: "<code>post.published</code> fires within <b>5–30 seconds</b> (Meta processing time, especially for video).",
    },
  ],

  colophon: "<b>Meta Graph.</b> One OAuth, three surfaces. Review queue: 8–12 weeks (we handle it).",
};

const facebook: PlatformContent = {
  heroH1: { before: "Ship Your", after: "Integration", emphasize: "In Minutes, Not Weeks." },
  heroSub: "Through the same Meta app.",
  heroLede:
    "One Facebook Login grants Pages + IG Business + Threads in a single consent. <b>letmepost</b> handles the Page token exchange, multi-photo + video posting, and the 63,206-character body limit (yes, really).",
  reassurance:
    'In review · Meta Graph · <a href="https://docs.letmepost.dev/platforms/facebook">read the docs →</a>',
  miniCode: `{
  "targets": [{ "platform": "facebook" }],
  "accountId": "acc_fb_xyz",
  "text": "Page post via letmepost."
}`,

  vsHead: "Why letmepost vs Meta Graph direct?",
  vsDirect: [
    { body: "You file Meta App Review (8–12 weeks shared across IG + FB + Threads)" },
    { body: "You handle the Page Access Token exchange" },
    { body: "You implement multi-photo (sequential upload + finalize)" },
    { body: "You build video upload via the /videos endpoint" },
    { body: "You parse Page-vs-User token errors" },
    { body: "You wrestle with the per-Page rate-limit headers" },
  ],
  vsLetmepost: [
    { body: "Our reviewed Meta app covers hosted users" },
    { body: "Page tokens exchanged + cached server-side" },
    { body: "Up to 10 photos as one POST" },
    { body: "Video posts via single /videos endpoint, abstracted" },
    { body: "Errors normalized to letmepost's stable envelope" },
    { body: "Per-Page rate limit surfaced as structured 429s" },
  ],

  highlight: {
    tone: "good",
    title: "✓  One OAuth, three Meta surfaces",
    body: "Facebook Login for Business is the same consent that lights up Instagram Business and Threads. <b>One grant, three publishers.</b> Useful when your customer manages a Page + linked IG + Threads.",
  },

  playground: {
    steps: ["Connect", "Configure", "Execute"],
    body: "Facebook Login for Business. Pick the Pages your app should post to. Page Access Tokens exchanged and stored encrypted.",
    cta: { href: "https://dashboard.letmepost.dev/connect", label: "CONNECT META →" },
    result: "Approval-gated.",
    resultCaption: "META REVIEW · DAY 24 / ~56",
  },

  contentTypes: [
    { label: "Text post", icon: "text-aa", note: "63,206 chars" },
    { label: "Photo", icon: "image" },
    { label: "Multi-photo", icon: "frame-corners", note: "up to 10" },
    { label: "Video", icon: "video-camera" },
    { label: "Scheduled", icon: "clock" },
  ],

  steps: [
    { title: "Get your API key", body: "Sign up at <code>dashboard.letmepost.dev</code>." },
    {
      title: "Connect via Facebook Login",
      body: "Pick the Pages you want to post to. Page Access Tokens exchanged + cached server-side.",
    },
    {
      title: "Post to a Page",
      body: 'One <code>POST /v1/posts</code> with <code>platform: "facebook"</code>. We handle the Page token, post, fire the webhook.',
    },
  ],

  features: [
    {
      icon: "check-circle",
      title: "Meta App Review absorbed",
      body: "Same review that covers Instagram + Threads. You inherit it.",
    },
    {
      icon: "key",
      title: "Page Access Tokens cached",
      body: "Page tokens exchanged from the user grant + cached server-side. We refresh proactively on the documented schedule.",
    },
    {
      icon: "frame-corners",
      title: "Multi-photo as one POST",
      body: "Up to 10 photos in a single post. We upload sequentially, finalize, return one post URL.",
    },
    {
      icon: "video-camera",
      title: "Video posts, abstracted",
      body: "/videos endpoint handled. Max ~4GB, max ~240 min per Facebook's limits.",
    },
  ],

  codeExample: {
    file: "publish-facebook.ts",
    caption: "post to a page · typescript",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

const result = await lmp.posts.create({
  targets: [{ platform: 'facebook', accountId: 'acc_fb_page_xyz' }],
  text: 'New launch post on the Page. With a 4-photo gallery.',
  media: [
    { type: 'image', url: 'https://your-image-1.jpg' },
    { type: 'image', url: 'https://your-image-2.jpg' },
    { type: 'image', url: 'https://your-image-3.jpg' },
    { type: 'image', url: 'https://your-image-4.jpg' },
  ],
});`,
  },

  faqSubtitle: "about facebook page posting",
  faqs: [
    {
      q: "When does Facebook go live?",
      a: "Publisher shipped, in Meta App Review (shared with IG + Threads). Typical 8–12 weeks.",
    },
    {
      q: "Personal profile vs Page?",
      a: "Pages only. Meta has restricted personal-profile API publishing for years.",
    },
    {
      q: "How do I post to multiple Pages?",
      a: "Each Page is a separate <code>accountId</code> in letmepost. One consent fans out to all the Pages the user picks.",
    },
    {
      q: "Video uploads?",
      a: "Via the /videos endpoint. We handle multipart upload + status poll. Max ~4GB, ~240 minutes (Facebook's limits).",
    },
    {
      q: "Can I post to a Group?",
      a: "Not in v1. Groups have a separate API with different scopes.",
    },
  ],

  finalCtaH2: "READY FOR FACEBOOK PAGES?",
  finalCtaLede:
    "Pages + IG Business + Threads on one consent. <b>Live the day Meta approval clears.</b> Or self-host today with your own Meta app.",
  finalCtaPrimaryLabel: "START FREE →",
  finalCtaSecondaryLabel: "READ DOCS",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/platforms/facebook",

  closeoutThanks: "* * * META GRAPH · PAGES * * *",
  closeoutCodeLine: "PLAT · FACEBOOK · META REVIEW",

  marg: [
    {
      tag: "OAuth",
      body: "Facebook Login for Business. One consent grants Pages + linked IG Business + Threads.",
    },
    {
      tag: "Limits",
      body: "63,206-char text. 10 photos OR 1 video. Video ≤ 4GB, ≤ 240 min.",
    },
    {
      tag: "Page tokens",
      body: "Exchanged from the user grant + cached server-side. Refreshed proactively.",
    },
    {
      tag: "App Review",
      body: 'Shared review with IG + Threads. Self-host with <code>LMP_META_APP_MODE=byo</code> for your own grant.',
    },
    {
      tag: "Self-host",
      body: "BYO Meta App with the right Page permissions to skip the queue.",
    },
  ],

  colophon: "<b>Meta Graph.</b> Pages + IG fan-out. Big text, many photos, one POST.",
};

const tiktok: PlatformContent = {
  heroH1: { before: "Ship Your", after: "Integration", emphasize: "In Minutes, Not Weeks." },
  heroSub: "Content Posting API. v2 scope.",
  heroLede:
    "TikTok's Content Posting API + creator OAuth flow, gated by a CASA-style security audit. <b>letmepost</b> has the publisher in build. Flip-the-switch is one config change once the audit clears. Self-hosters with their own TikTok developer app + audit cert can use it today.",
  reassurance:
    'Planned · Content Posting API · <a href="https://docs.letmepost.dev/platforms/tiktok">read the docs →</a>',
  miniCode: `{
  "targets": [{ "platform": "tiktok" }],
  "accountId": "acc_tt_xyz",
  "text": "Posted via letmepost.",
  "options": { "privacyLevel": "PUBLIC_TO_EVERYONE" }
}`,

  vsHead: "Why letmepost vs Content Posting API direct?",
  vsDirect: [
    { body: "You complete TikTok audit verification (6–12 weeks)" },
    { body: "You implement resumable upload across multiple requests" },
    { body: "You manage daily quota cost across all endpoints" },
    { body: "You handle restricted-scope vs unrestricted-scope errors" },
    { body: "You parse the Creator vs Business-account distinction" },
    { body: "You track Google's quota deductions per call type" },
  ],
  vsLetmepost: [
    { body: "Our reviewed Google project covers hosted users (when CASA clears)" },
    { body: "Resumable upload abstracted; one POST + a mediaId" },
    { body: "Quota cost surfaced per-call in the response envelope" },
    { body: 'Scope errors mapped to <code>tiktok_scope_mismatch</code>' },
    { body: "Creator vs Business handled at connect time" },
    { body: "Daily quota tracked + surfaced via <code>quota.warning</code> webhook" },
  ],

  highlight: {
    tone: "warn",
    title: "⚠  the security audit gates production",
    body: "TikTok's Data API write access goes through Google's CASA security audit. <b>6–12 weeks typical.</b> letmepost has the publisher shipped and is sitting in the queue. Self-host users with their own Google project + CASA cert can use it today.",
  },

  playground: {
    steps: ["Connect", "Configure", "Execute"],
    body: "Google OAuth + Channel pick. Self-host with your own Google project + CASA cert to use it today.",
    cta: { href: "https://dashboard.letmepost.dev/connect", label: "CONNECT YOUTUBE →" },
    result: "Approval-gated.",
    resultCaption: "CASA REVIEW · IN FLIGHT",
  },

  contentTypes: [
    { label: "Title", icon: "text-aa", note: "100 chars" },
    { label: "Description", icon: "text-aa", note: "5,000 chars" },
    { label: "Video", icon: "video-camera", note: "MP4 ≤ 256GB" },
    { label: "Thumbnail", icon: "image", note: "verified channels" },
    { label: "Scheduled", icon: "clock" },
  ],

  steps: [
    { title: "Get your API key", body: "Sign up at <code>dashboard.letmepost.dev</code>." },
    {
      title: "Connect a TikTok channel",
      body: "Google OAuth. Pick the channel. Creator vs Business-account distinction handled.",
    },
    {
      title: "Upload a video",
      body: 'One <code>POST /v1/posts</code> with the video <code>mediaId</code>. We handle resumable upload, fire <code>post.published</code> when TikTok finalizes.',
    },
  ],

  features: [
    {
      icon: "shield-check",
      title: "CASA-aware",
      body: "Hosted users wait on our review; self-host users plug their own Google project + CASA cert.",
    },
    {
      icon: "cloud-arrow-up",
      title: "Resumable upload abstracted",
      body: "Multi-MB videos use Google's resumable upload protocol. We handle init + chunks + finalize as one SDK call.",
    },
    {
      icon: "gauge",
      title: "Quota cost surfaced",
      body: 'Every endpoint costs quota units. We surface the unit cost per call and fire <code>quota.warning</code> when you approach the daily cap.',
    },
    {
      icon: "video-camera",
      title: "MP4 first, ≤ 256GB / 12h",
      body: "Standard h.264 MP4 path. Per-channel daily upload limits enforced via Google's documented thresholds.",
    },
  ],

  codeExample: {
    file: "publish-tiktok.ts",
    caption: "upload a video · typescript",
    code: `import { Letmepost } from '@letmepost/sdk';
const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY });

const result = await lmp.posts.create({
  targets: [{ platform: 'tiktok', accountId: 'acc_yt_xyz' }],
  text: 'A demo of letmepost. Posted via the API.',
  media: [{ type: 'video', mediaId: 'med_video_xyz' }],
  options: {
    tiktok: {
      title: 'letmepost demo',
      privacyStatus: 'unlisted',
      categoryId: '28', // Science & Technology
    },
  },
});`,
  },

  faqSubtitle: "about tiktok uploads",
  faqs: [
    {
      q: "When does TikTok go live?",
      a: "Hosted users wait on TikTok audit verification (6–12 weeks). Self-host with your own Google project + CASA cert today.",
    },
    {
      q: "What's CASA?",
      a: "Cloud Application Security Assessment. Google's audit for apps requesting restricted scopes like TikTok write. Annual recertification required.",
    },
    {
      q: "How big can videos be?",
      a: "≤ 256GB or 12h, whichever first. Standard h.264 MP4. Resumable upload handled.",
    },
    {
      q: "Quota cost?",
      a: 'Uploads cost ~1,600 units, list calls cost 1, comments cost 50. Daily cap is 10,000 units default. We surface unit cost per call + fire <code>quota.warning</code> approaching the cap. <a href="https://docs.letmepost.dev/tools/tiktok-quota-cost-calculator">Calculator tool</a>.',
    },
    {
      q: "Shorts vs full videos?",
      a: 'Both upload through the same endpoint. <code>privacyStatus</code>, <code>categoryId</code>, and <code>tags</code> map to the standard Content Posting API fields.',
    },
  ],

  finalCtaH2: "READY FOR YOUTUBE?",
  finalCtaLede:
    "Self-host today with your own Google project + CASA cert. Hosted users queue up; live when CASA clears. <b>Same publisher either way.</b>",
  finalCtaPrimaryLabel: "START FREE →",
  finalCtaSecondaryLabel: "READ DOCS",
  finalCtaSecondaryHref: "https://docs.letmepost.dev/platforms/tiktok",

  closeoutThanks: "* * * DATA API v3 · CASA · IN BUILD * * *",
  closeoutCodeLine: "PLAT · YOUTUBE · PLANNED",

  marg: [
    {
      tag: "CASA",
      body: "Cloud Application Security Assessment. 6–12 weeks. Annual recertification. Self-host with your own audit to skip ours.",
    },
    {
      tag: "Limits",
      body: "100-char title. 5,000-char description. Video ≤ 256GB or 12h. Standard MP4 (h.264).",
    },
    {
      tag: "Quota",
      body: 'Upload 1,600 units, list 1, comment 50. Daily cap 10,000 default. <a href="https://docs.letmepost.dev/tools/tiktok-quota-cost-calculator">Calculator</a>.',
    },
    {
      tag: "Self-host",
      body: "BYO Google project + CASA cert and use it today. Same publisher code, your audit record.",
    },
    {
      tag: "Webhook timing",
      body: "<code>post.published</code> fires when TikTok finishes processing. Varies <b>30s–5min</b> depending on video length.",
    },
  ],

  colophon: "<b>Content Posting API.</b> CASA-gated. Self-host today, hosted when audit clears.",
};

export const PLATFORM_CONTENT: Record<string, PlatformContent> = {
  bluesky,
  twitter: x,
  pinterest,
  linkedin,
  threads,
  instagram,
  facebook,
  tiktok,
};
