# letmepost.dev — Status & Pre-Launch Checklist

> Single source of truth for what's shipped, what's pending external approval, and what's left before the public v1 launch. Replaces the original 15-phase build roadmap (every phase except 15 has landed in code).
>
> **Don't use this as a kanban.** The day-to-day work board is the Notion *Product Development* DB in the `letmepost.dev` workspace. This file documents the steady-state.

---

## Status snapshot (June 2026)

Everything from the original roadmap that doesn't depend on calendar-gated reviews is shipped. The remaining work is content (blog posts, demo videos), demos in flight, and the v1 launch itself.

**Production deploys:**

- API — `https://api.letmepost.dev` (Railway)
- Worker — same Railway project, separate service
- Dashboard — `https://dashboard.letmepost.dev` (Vercel)
- Marketing — `https://letmepost.dev` (Vercel, Astro)
- Docs — `https://docs.letmepost.dev` (Mintlify)
- MCP — `https://api.letmepost.dev/mcp` (streamable HTTP, stateless)
- npm — `@letmepost/sdk`, `@letmepost/mcp`, `@letmepost/cli`
- PyPI — `letmepost` (generated from OpenAPI)
- Go — `github.com/letmepost/letmepost-go` (generated)

**Infra:** NeonDB Postgres (branching-per-preview), Upstash Redis (BullMQ), S3 `letmepost-media`, Resend (transactional + onboarding sequence), Lemon Squeezy (billing), Sentry (api + worker + dashboard), Axiom (logs + traces), PostHog (web + dashboard product analytics).

**Cross-subdomain auth:** better-auth with `COOKIE_DOMAIN=.letmepost.dev`; email/password + Google + GitHub social sign-in with account linking; first-touch UTM attribution snapshot on signup.

---

## Platforms

Canonical state lives in `packages/schemas/src/platform-state.ts`; the dashboard connect drawer, marketing site, and backend connect gate all read from the same map. `PLATFORM_STATE_OVERRIDES` env can flip a platform without a redeploy.

| Platform | State | Notes |
|---|---|---|
| Bluesky | **live** | Text, single image, multi-image (4-up carousel), video via `app.bsky.video.uploadVideo` service flow + job poll. Alt-text round-trip. |
| Pinterest | **live** | Image pins, video pins (`POST /v5/media` → S3 multipart → poll → `createPin` with `source_type: video_id`), board picker, default-board setting. Standard Access cleared. |
| Twitter / X | **live** | OAuth 2.0 PKCE (codeVerifier embedded in signed state), up to 4 images per tweet, alt-text via v1.1, chunked video upload (INIT/APPEND/FINALIZE/STATUS), reply chains, quote tweets, t.co-aware grapheme counter, 50-billable-posts-per-account-per-30d launch cap. |
| LinkedIn | **live** | Personal + organization posting via the AccountProvider framework. 3,000-grapheme emoji-aware preflight, URN validation, `LinkedIn-Version` pinning, ACL preflight for org posts. MDP cleared. |
| Facebook | **live** | Text, single photo, multi-photo, video. FBLB OAuth fan-out grants Pages + linked IG Business + Threads in one consent. App Review cleared. |
| Instagram | **live** | Single image, single video / Reels, 2–10 mixed-media carousel. URL-source preflight (direct answer to the Google-Drive-URL failure pattern), `OAuthException 2207052` mapped. Async media-publish polling — we await and surface. App Review cleared. |
| Threads | **live** | Text, image, video, 2–20 mixed carousel, replies. App Review cleared. |
| TikTok | **pending** | Publisher fully built: OAuth 2.0 PKCE, `push_by_file` upload to inbox, status-poll worker with bucketed backoff (5s → 30s → 120s up to 30 min). State flips on App Review approval — code is ready, no further work needed there. Posts go to inbox with `privacy=SELF_ONLY` until Direct Post (`video.publish`) audit clears. |

**Deferred to v2+:** YouTube (CASA verification path; deprioritized vs TikTok in the April 2026 scope update), Reddit, Telegram, Discord, Snapchat, Google Business, WhatsApp.

---

## What's shipped

### Core API

- **`POST /v1/posts`** — single endpoint, accepts text + media + scheduling + per-platform overrides + idempotency key. Dual auth: Bearer API key *or* dashboard session cookie.
- **`POST /v1/posts/validate`** — preflight only, no publish. Useful for CI integration.
- **`PATCH /v1/posts/:id`** — reschedule a queued post. Atomic (remove BullMQ job → re-enqueue at new delay → persist time). Window-gated to `status=queued AND scheduledAt > now`.
- **`DELETE /v1/posts/:id`** — cancel a queued post. Same window. Transitions row to terminal `canceled` status. Worker race-safe: queued→publishing transition is a conditional `UPDATE … WHERE status IN ('queued','validated')` so a `DELETE` landing mid-flight matches zero rows and the worker bails cleanly.
- **`POST /v1/posts` mediaRefs persisted** on scheduled inserts so the worker publishes the same media the caller submitted.
- **`POST /v1/media`** — multipart upload, streamed direct to S3 via `@aws-sdk/lib-storage`'s `Upload`. Returns `{ id, url, contentType, sizeBytes, sha256 }`. Public-read via bucket policy on `s3:GetObject`; security rests on ~131-bit key entropy (`med_` + 22 base62).
- **`POST /v1/accounts/connect/:platform`** — returns OAuth URL or app-password form. Accepts validated `returnTo` (against `DASHBOARD_URL` + `TRUSTED_ORIGINS`) so the marketing-site demo and dashboard can both use it.
- **`GET /v1/accounts/oauth/:platform/callback`** — generic callback router.
- **`/v1/accounts`**, **`/v1/api-keys`**, **`/v1/webhook-endpoints`**, **`/v1/profiles`** — CRUD with org + profile scoping.
- **`/v1/billing/checkout`**, **`/v1/billing/portal`**, **`/v1/lemonsqueezy/webhook`** — Lemon Squeezy integration.
- **`/v1/oauth-exchange`** — trades a verified OAuth JWT for a plaintext API key. CLI's `lmp login` flow.
- **`/v1/resend/webhook`** — svix-signed delivery + complaint events from Resend.
- **`/.well-known/oauth-authorization-server`** + **`/.well-known/oauth-protected-resource`** — RFC 8414 + RFC 9728, with `/api/auth` and `/mcp` suffixed variants.
- **`/v1/platform-versions`** — public version tracker endpoint (LinkedIn-Version, X API tier, IG Graph version, …).
- **`/v1/data-deletion`** — Meta-required deauth + data-deletion callback.

### Reliability + contracts

- **Idempotency-Key** on all writes — 24h replay window, stored response fingerprint, body-hash conflict detection.
- **Canonical `ErrorResponse`** — `code`, `rule`, `platform`, `platform_version`, `platform_response`, `remediation`, `request_id`, `trace_id`.
- **Error code registry** — one docs page per code (11/11). Codes: `unauthenticated`, `unauthorized`, `validation_failed`, `preflight_failed`, `platform_rejected`, `platform_auth_failed`, `platform_unavailable`, `platform_not_enabled`, `rate_limited`, `idempotency_conflict`, `not_found`, `internal_error`.
- **Per-platform preflight rule pages** — ~95 individual preflight rule pages on docs (Bluesky, Pinterest, Twitter, LinkedIn, Meta trio, TikTok + cross-platform).
- **`@upstash/ratelimit`** — per-key quota + per-IP floor + per-platform connect-attempt floor.
- **AES-256-GCM envelope encryption** for OAuth token blobs (DEK per token, KEK in env, rotation-ready).
- **OAuth state HMAC-signed** with 10-min TTL; X PKCE `codeVerifier` rides the same envelope so dashboard full-page redirects don't lose it.
- **Twitter launch cap** — 50 billable posts (`published`/`rejected`/`failed`) per account per rolling 30 days, enforced via the `PublishContext` gate pattern in `_shared/dispatch.ts`. Returns `rate_limited` 429 with `Retry-After` from the oldest billable post.
- **Pre-publish gate pattern** — gates throw `LetmepostError`, live in `platforms/<name>/<gate>.ts`, called from `_shared/dispatch.ts`. Required-not-optional `db` on `PublishContext`. Documented in `CONTRIBUTING.md` §3.5.

### Queue + webhooks

- **BullMQ on Upstash Redis** — queues: `publish`, `validate`, `refresh-token`, `webhook-deliver`, `onboarding-email`, `tiktok-publish-status-poll`, `billing-dunning`, `log-retention`.
- **Stable BullMQ jobIds** — `publish:<postId>` so cancel/reschedule can find and replace by post id.
- **18 webhook event types** — `post.queued`, `post.validated`, `post.published`, `post.rejected`, `post.failed`, `post.canceled`, `post.rescheduled`, `token.expiring`, `token.revoked`, `version.deprecated`, `subscription.activated`, `subscription.cancelled`, `subscription.tier_changed`, `quota.warning`, `quota.exceeded`, `billing.payment_failed`, `billing.delinquent`, `billing.recovered`.
- **HMAC-SHA256 webhook signing**, exponential backoff, dead-letter queue, per-endpoint event filter, **Send Test** button in the dashboard fires a synchronous test delivery with per-type editable JSON payload.

### Billing (Lemon Squeezy)

- **Three tiers** locked: Free (50 posts/mo), Pro ($79/mo for 5,000), Business ($299/mo for 25,000). Self-host is unlimited. Enterprise dropped from the ladder until a sales path exists.
- **Body-hash event id** — Lemon Squeezy has no `X-Event-Id` header.
- **Checkouts API** (not legacy `/buy/` URL).
- **Fail-soft invoices** so dashboard always renders.
- **CSRF-hardened webhook**, status-aware (respects LS subscription state).
- **Quota gate on `POST /v1/posts`** — idempotent replays skip the counter (idempotency middleware short-circuits before the handler). Infinity-quota tiers (self_host) bypass the cap.
- **Dunning + retention jobs** — hourly past_due → delinquent sweep; nightly per-org log cleanup respecting tier retention windows (Free 14d / Pro 30d / Business 180d).
- **`BILLING_ENABLED` env gate** for self-host.

### Profiles (free org-structure primitive)

- `profiles` table; `platform_accounts.profile_id` NOT NULL with a "Default" profile auto-created per org.
- `api_keys.scope` accepts optional `profile_id` (empty scope = org-wide).
- `/v1/profiles` CRUD; `/v1/accounts` and `/v1/posts` enforce scope.
- Profile-scoped query keys + `?profileId=` filter on the dashboard; post + webhook lifecycle events carry `profileId`.
- **Cross-profile keys 404, not 403** — avoids leaking existence.

### Media service

- S3 bucket `letmepost-media`, Object Ownership = "Bucket owner enforced", keys `${env}/${orgId}/${mediaId}.${ext}`.
- `MediaInput` variants: `{ kind, mediaId }` (preferred), `{ kind, url }` (passthrough for callers with their own CDN), `{ kind, bytesBase64 }` (tiny images).
- Shared `apps/api/src/platforms/_shared/media.ts` resolver — every publisher calls `resolveMedia(item)`.

### SDKs + agent tooling

- **`@letmepost/sdk`** — hand-written TypeScript client mirroring every `/v1/*` endpoint. Idempotency-key helper, webhook signature verifier, typed error classes, retry/backoff.
- **Python (`letmepost`) + Go (`github.com/letmepost/letmepost-go`)** — generated from OpenAPI 3.1 (down-converted to 3.0 for Go's `oneOf` codegen).
- **`@letmepost/mcp`** — stdio MCP server. `npx @letmepost/mcp@latest`. 21 tools generated from the OpenAPI spec.
- **`@letmepost/cli`** — `npm i -g @letmepost/cli` → `lmp` binary. Commands: `login`, `logout`, `whoami`, `version`, `accounts`, `posts`, `post`, `profiles`. Config at `~/.letmepost/config.json`.
- **Hosted MCP** at `api.letmepost.dev/mcp` — streamable HTTP, stateless. Accepts API keys *or* OAuth 2.1 bearer tokens.

### OAuth 2.1 provider

- **Dynamic Client Registration** (RFC 7591) — MCP clients self-register at install.
- **PKCE-only flow** — no client secrets in fat clients.
- **RFC 8707 resource indicators** — `aud` claim is the MCP endpoint URL, validated per-tool-call.
- **Path-suffixed well-known** endpoints (RFC 8414, RFC 9728).
- **`WWW-Authenticate: Bearer resource_metadata="..."` on `/mcp`** so MCP clients discover the OAuth surface from a single header.
- **Hosted login + consent screens** on the dashboard.
- **`/mcp` accepts both shapes** — API keys (`lmp_live_` / `lmp_test_` prefix) pass through; JWTs are JWKS-verified and mint a per-user `letmepost-mcp` API key on first use, cached by `sub`.

### Dashboard (`apps/dashboard`)

Next.js App Router, better-auth session, shadcn, Commit Mono + Instrument Serif wordmark, framer-motion blur+y transitions.

- **Sign-in / sign-up** with email/password + Google + GitHub. Sign-up handles unverified-email path via a `/verify-email` polling screen that forwards to `/onboarding` once the session arrives. Org name typed at signup is stashed and recreated post-verify.
- **`/onboarding`** — silent recovery for sessions without an active org. Picks the first existing org, else creates one named after the user.
- **`/`** — first-run accordion checklist (Copy your API key → Connect a platform → Send your first post) with per-step bodies (curl preview, brand-icon platform grid, live "Send test post"). Fades to count cards when complete.
- **`/posts`** — primary compose surface (renamed from old `/posts` which is now `/logs`). Grid + list + calendar subroutes. Create Post sheet modeled on Zernio's two-column shape (content left, profile + accounts + Schedule / Now / Queue / Draft tabs right). shadcn calendar + popover for scheduler input. Calendar month view with chips per day, day-sheet on `+N more`.
- **`/logs`** — TanStack Table post log. Server-side filters: profile × platform × status × error-code × time-range. Detail view: full ErrorResponse contract, attempts timeline, copy-as-curl with pre-filled key prefix and `mediaRefs` + `scheduledAt`.
- **`/calendar`** — month grid; click a chip → side drawer with reschedule (shadcn calendar) + cancel buttons wired to the `PATCH`/`DELETE` endpoints.
- **`/accounts`** — list + connect + descriptor-driven dynamic field form for credential platforms. Per-profile filter.
- **`/profiles`** — CRUD with auto-derived slug, delete-blocked-when-non-empty surfaced as a 409 toast.
- **`/api-keys`** — list / create (Name + Environment + Scope) / revoke. Plaintext shown once with auto-copy on creation.
- **`/webhooks`** — CRUD + Send Test dialog (event-type select + editable JSON + delivery result panel).
- **`/billing`** — plan card, animated usage meter (polled every 60s), upgrade flow, invoices list, eager-written cancel + reactivate state.
- **`/settings`** — Usage / Profile / Danger Zone tabs.
- **`/media`** — upload + library.
- **`/analytics`** — placeholder with `feature.requested` vote button.
- **Sidebar** — brand mark, sectioned nav, org dropdown with `switch-organization` submenu, theme icon in header, billing in account dropdown.

### Marketing site (`apps/web`)

Astro, receipt-themed visual identity, brand mark + wordmark synced to dashboard + docs.

- **`/`** — hero, "fails loudly" pitch, code-block tabs (curl / TS / Python), itemized `WHAT YOU GET`, platform status strip, error envelope sample, MCP teaser, tariff sheet, fine-print FAQ, final centered CTA. Latest-writing strip pulls from `/blog`.
- **`/platforms/[slug]` × 8** — hero with status badge, code sample, content-type chips, demo placeholder, how-it-works, features grid, gotcha callouts.
- **`/api/[slug]` × 3** — Publishing API, Media API, Webhooks. Hero, code sample, feature grid.
- **`/pricing`** — Three-card tier (Free / Pro $79 / Business $299), Business+ enquiry block, billing FAQ.
- **`/agents`** — MCP-first landing. OAuth 2.1 + DCR, stdio binary, hosted streamable-HTTP. Agent-builder FAQ.
- **`/about`** — solo, open source, built in public.
- **`/blog`** — Notion-backed via daily Vercel cron rebuild. Reading-view design, single column, large type, syntax-highlighted code, breadcrumbs, alt-text on cover images, self-hosted fonts for FCP.
- **`/status`** — service-health stub.
- **`/terms`**, **`/privacy`**, **`/data-deletion`**, **`/contact`** — legal + Meta-required.
- **`/llms.txt`** — concise spec for LLM crawlers.
- **`/rss.xml`** — feed for `/blog`.
- **Full SEO suite** — sitemap with priority/changefreq/lastmod, JSON-LD on every page (Organization + WebSite + FAQPage + BreadcrumbList + SoftwareApplication + Product + BlogPosting), `twitter:site`/`creator`, AI-crawler robots.txt directives (GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-Web, PerplexityBot, Google-Extended, anthropic-ai, cohere-ai, Applebot-Extended, Bytespider).
- **PostHog product analytics** — typed `track()` helper, ~30 events covering marketing CTAs, signup → first-publish funnel, OAuth lifecycle, post lifecycle, api-keys, webhooks, theme/org. Person identification via better-auth session with active org as a PostHog group. Conventions in `CONTRIBUTING.md` §11.

### Documentation (`docs/`, Mintlify Maple)

~120 MDX pages at `docs.letmepost.dev`. Tabs: Quickstart / Platforms / Webhooks / API Reference / Errors / Preflight.

- **Quickstart**: quickstart, authentication, idempotency, errors index, preflight index.
- **Agents**: MCP, CLI.
- **Guides**: connect-account, publish-post, schedule-post, upload-media, migrate-from-{postiz, ayrshare, buffer}.
- **Self-host**: quick-start, environment, platform-credentials, deploying, troubleshooting.
- **Platforms** (one per platform × 8): caps, scopes, gotchas, code samples.
- **Errors** (one per code × 11).
- **Preflight** (one per rule × ~95, grouped by platform).
- **API Reference** — auto-rendered from `docs/api-reference/openapi.json` (Zod-derived).
- **Webhooks** — one page per event type.
- **Changelog** + **Pricing** + **SDKs** (TS / Python / Go).
- Navbar: Dashboard CTA, GitHub link, X link, llms.txt, OpenAPI download.
- Contextual menu enabled (Copy / View / ChatGPT / Claude).

### Observability + ops

- **Sentry** on api + worker + dashboard. Node services via separate `instrument.mjs` loaded with `node --import` for ESM-compatible OpenTelemetry auto-instrumentation. Dashboard via `@sentry/nextjs`. Production Dockerfile copies `instrument.mjs` into the image.
- **Axiom** OTel exporter for logs + traces.
- **PostHog** product analytics across web + dashboard.

### Email (Resend)

- **Founder-voice onboarding sequence** — D0 welcome, D1 first-post nudge, D3 stuck-check, D5 webhooks nudge, D7 Sean Ellis PMF question. Gated on email verification. Each email is a pure function of the user's state; D1/D3/D5 skip themselves when their gating condition is already met. Signed `kamal`.
- **`Idempotency-Key` deduplication** at the Resend layer.
- **Svix-signed webhook** for delivery + complaint events.
- **Suppression list** — hard bounces and complaints write to `email_suppressions` (PK on lowercased email). Onboarding worker checks before sending. Best-effort cancellation of queued onboarding jobs for newly-suppressed addresses.
- **RFC 2369 `List-Unsubscribe`** mailto header on every transactional email. RFC 8058 one-click skipped pending the HTTPS endpoint.

---

## Approvals — open

- **TikTok App Review** — submitted. Publisher is fully built; state flips from `pending` → `live` the day approval clears. Sandbox / audit accounts post to inbox with `privacy=SELF_ONLY` until then.
- **Pinterest Standard Access** — cleared.
- **Meta App Review** (IG + FB + Threads) — cleared.
- **LinkedIn MDP / Community Management API** — cleared.
- **X Pay Per Use** — signup complete; launch cap (50 billable posts / account / 30d) in place as the cost backstop.
- **YouTube CASA verification** — not started. Deprioritized; YouTube is currently a v2 candidate.

---

## Pre-launch — what's left

The remaining work is content, demos, and one-off polish.

### Content

- **First 2–3 blog posts** in the launch series. Candidates: LinkedIn version-churn flagship; "fails loudly" thesis; OAuth lifecycle deep-dive; idempotency vs retry-storms. Notion is the source for `/blog`.
- **Migration guides** (`/migrate/[from]` or `docs/guides/migrate-from-*`): Ayrshare drafts polished, Postiz + Buffer flesh-out.
- **Per-platform live-connect demo** in the playground card on each `/platforms/[slug]` page (placeholder structure exists; backend `returnTo` carve-out works — just needs UI wiring).
- **Live preflight-failure demo** on the home page (currently a static error sample).
- **Public API Version Tracker UI** rendering `GET /v1/platform-versions` (API exists; docs landing for it doesn't).

### Code TODOs

- `apps/api/src/platforms/twitter/provider.ts` — call `GET /2/users/me` on `completeConnect` to replace the synthetic `twitter-${uuid}` `platformAccountId` with the real X user id. One TODO marker; ~30 LOC.
- **Scheduled-post per-platform overrides** — `mediaRefs` is persisted on schedule; Pinterest `boardId` / Threads `replyToId` / Twitter `replyToTweetId,quoteTweetId` are not. Worker degrades to platform defaults for those. Add columns + back-fill before the launch.
- **Eviction / lifecycle policy** for the S3 media bucket. Not v1 unless a real bandwidth bill shows up.
- **Test brittleness** — 5 pre-existing failures in `tests/accounts.test.ts` + `tests/post-log.test.ts` (session-auth path). Worth a focused fix slice before launch. Tests for `assertPlatformEnabled` + X launch-cap paths are also pending — preflight-style, no real DB; should land before public launch.

### Pre-flight on the launch gate

- **Smoke-test the platform-state gate in production-like env**: connect drawer should grey out `pending` tiles, `tiktok` should 403 with `platform_not_enabled` on POST `/v1/accounts/connect/tiktok`.
- **End-to-end smoke for all 7 live platforms** — connect, publish, idempotency replay, webhook delivery, error contract surfacing.
- **Self-host** — `docker compose up` against fresh Postgres + Redis. Same API responses as hosted.
- **Lighthouse 100** on all marketing + docs pages (mobile + desktop). Add to CI.
- **k6 load test** against staging — establish baseline, tune BullMQ concurrency.
- **Security review** of token-encryption + webhook-signature paths.

### Launch artifacts

- HN launch post + comment-response staffing for day one.
- Bluesky + LinkedIn + X announcement threads (each platform's account auto-publishes via letmepost).
- Show HN.
- n8n community node — scaffold + publish.
- Product Hunt scheduled +7 days from HN.
- Outreach DM templates for n8n / Make / Zapier community-node maintainers.

---

## Verification — when v1 is shippable

1. All "live" platforms publish a real post end-to-end through the hosted API with idempotency + webhooks + error mapping verified.
2. Contract tests green on cron (real API, not MSW) for every live platform for 7 consecutive days.
3. **Profile isolation verified** — a profile-scoped API key cannot read, publish from, or modify accounts in a sibling profile. Cross-profile access 404s. Org-wide keys keep working against any profile.
4. **Post Log renders the full error contract** for every failure class (`preflight_failed`, `platform_rejected`, `platform_auth_failed`, `platform_unavailable`, `validation_failed`, `internal_error`, `idempotency_conflict`, `rate_limited`), with raw platform response visible and copy-as-curl on every row.
5. **Docs parity** — every error code has a page; every preflight rule has a page with upstream citation; every endpoint has runnable examples in TS / Python / Go / cURL.
6. **SDK parity** — TS, Python, Go on their respective registries; smoke tests green.
7. **Self-host parity** — `docker compose up` works against fresh Postgres + Redis.
8. **Lighthouse 100** on all marketing + docs pages.
9. **Load test** — API handles 500 req/s sustained on a single Railway instance with p95 < 250ms (excluding upstream platform latency).
10. **Pricing live** with committed tier shape (Free / $79 / $299 / self-host unlimited).
11. **n8n community node published** and linked in docs.

---

## Scope contract — what's explicitly v2+

The answer is "not in v1" for the following, in priority-of-being-asked order:

- **Inbox surfaces** — DMs, comments, comment replies, review replies, comment-to-DM automations. Entire product line.
- **Analytics dashboards** beyond post-log + error-log. Vote button captures demand.
- **Ads manager** across Meta/Google/YouTube/LinkedIn/Pinterest/X. Separate product line.
- **WhatsApp Business** (templates, flows, phone numbers, groups). Separate product line.
- **CRM-ish features** — contacts, sequences, broadcasts.
- **YouTube** — deprioritized vs TikTok in the April 2026 scope update. CASA verification path is real but slow; revisit post-launch.
- **Reddit, Telegram, Discord, Snapchat, Google Business** — long tail, <1k accounts each in the 90-day Zernio dataset.
- **Advanced media ops** — image editing, video trimming, auto-captioning, thumbnail generation.
- **Team-management UI** beyond single-org multi-member.
- **Whitelabel / agency tier UI.**
- **Per-profile / per-seat pricing** — *actively rejected*, not just deferred. Profiles are free in v1 as an org-structure primitive. Revisiting this is a `PRODUCT.md`-level decision.
- **Per-profile custom branding, per-profile webhook endpoints, cross-profile account sharing** — explicitly out of the Phase 5.5 profiles slice. Revisit only if a paying customer asks.
- **Ayrshare SDK drop-in adapter** — migration lever, not v1.
- **SOC 2, HIPAA, BAAs** — when a customer pays for them.

---

## Critical files

- `apps/api/src` — Hono app root. Every endpoint, middleware, platform publisher.
- `packages/schemas/src` — Zod source of truth. Feeds OpenAPI + docs.
- `packages/schemas/src/platform-state.ts` — canonical platform launch state.
- `apps/api/src/platforms/_shared/dispatch.ts` — the dispatcher every publisher hangs off, and where pre-publish gates run.
- `apps/api/src/db/schema/` — Drizzle schemas (17 tables today).
- `apps/web/src/data/platforms.ts` — marketing-site source of truth, reads from `platform-state`.
- `docs/docs.json` — Mintlify nav.
- `PRODUCT.md` — principles contract.
- `TECH.md` — stack contract.
- `CONTRIBUTING.md` — conventions (gate pattern §3.5, PostHog conventions §11).
