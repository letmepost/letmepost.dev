# letmepost.dev

> Open-source social media publishing API that fails loudly instead of silently.

## What this doc is

Internal product description. Source of truth for positioning, ICP, scope, and product principles so future Claude Code sessions (and future me) start from the same page. **Not a PRD. Not an implementation plan.** No user stories, no acceptance criteria, no sprint planning.

## What letmepost.dev is

A developer-grade HTTP API for publishing to social media platforms. A single endpoint contract (`POST /v1/posts`) that routes to Bluesky, LinkedIn, Twitter/X, Instagram, Facebook, Threads, Pinterest, and TikTok, with **preflight validation, transparent errors, stable API versioning, and idempotency keys** as first-class contracts.

Apache 2.0 core, hosted SaaS as the primary commercial offering, self-host as a first-class community option. Same code, same API, no feature gate between the two.

Also shipped as an **MCP server** (hosted at `api.letmepost.dev/mcp` and as a stdio binary on npm) and a **CLI** (`npm i -g @letmepost/cli`). Agent-builder ergonomics are a first-class concern, not a port.

## Who it's for

**Primary ICP — developers building automations and AI agents.** n8n, Make, Zapier, LangGraph, CrewAI. These are the people who discovered at 2 a.m. that their LinkedIn workflow broke because LinkedIn sunset an API version overnight. They are already paying for social posting (X API Basic is $200/mo minimum) and do not have a developer-grade primitive today.

**Secondary ICP — indie hackers and solopreneurs building cross-posting tools.** They currently hand-roll integrations because existing schedulers are "aimed at professional marketers with tons of features we don't need."

**Tertiary — agencies running n8n/Postiz stacks** who want to migrate off Hootsuite/Sprout/Later. Longer sales cycle, strong migration intent signal.

**Not the ICP — end-user creators.** Publer, Typefully, and Hypefury already serve them well, and creators don't buy APIs. We reach creators only indirectly, via UI partners that embed letmepost.dev.

## The problem we're solving

From the 2025-2026 research corpus (150+ citations across GitHub, Trustpilot, Capterra, Hacker News, Reddit, developer forums):

1. **Silent failures dominate developer complaints.** Posts report success then never appear. Tokens rot without warning. Scheduled posts disappear. Error payloads come back as `{ body: {}, message: '' }`. Every incumbent optimized for the happy path; none built for the moment things break.

2. **LinkedIn API version churn is a serial killer of automations.** LinkedIn sunset five API versions in six months (20240401, 20241001, 20241101, 20250101, 20250401), each time simultaneously breaking n8n Cloud, Zapier, Make, Pabbly, and Postiz. The fix in every case was a single HTTP header.

3. **Media upload validation failures are asynchronous and opaque.** Instagram Reels reject Google Drive URLs. Threads throws cryptic `OAuthException 2207052`. TikTok's `file_format_check_failed` and post-upload status-polling failures look identical to the caller until you decode them. Every one of these is catchable with client-side validation *before* the API call.

4. **OAuth token lifecycle is a production liability.** LinkedIn tokens expire every 60 days and require full re-auth. Meta Instagram: 60 days. Google Business Profile: needs daily refresh. Bluesky access JWTs: minutes.

5. **Per-profile / per-seat pricing is universally hated.** Buffer $6-12/channel, Ayrshare $8.99/profile/mo, Sprout $299-399/seat/year. Complaints dominate competitor Trustpilot scores (Hootsuite 1.4/5, Later 1.4/5, Sprout 1.9/5).

6. **Double-posting loops from retry storms.** The open-source benchmark (Postiz) shipped an infinite double-posting bug in Temporal workflows; the maintainer's own recommended fix was "idempotency keys with the external APIs."

The consistent signal across the corpus: **developers aren't complaining about scheduling — they're complaining about the invisibility of failure.**

## What the product does

At a high level, letmepost.dev exposes a small, opinionated API surface:

- **`POST /v1/posts`** — create or schedule a post across one or many platforms in a single call. Accepts an `Idempotency-Key` header.
- **`POST /v1/posts/validate`** — run preflight validation without sending. Returns the specific rules that would fail, so automations can self-check in CI or before queueing.
- **`PATCH /v1/posts/:id`** + **`DELETE /v1/posts/:id`** — reschedule or cancel a queued post atomically before the worker picks it up.
- **`POST /v1/media`** — multipart upload streamed to S3; resulting `mediaId` is referenceable from every publisher.
- **`POST /v1/accounts/connect/:platform`** — OAuth-backed account connection, including token refresh lifecycle management.
- **Webhooks** — 18 structured event types covering post lifecycle (`post.queued / validated / published / rejected / failed / canceled / rescheduled`), token lifecycle (`token.expiring / revoked`), platform churn (`version.deprecated`), and billing (`subscription.* / quota.* / billing.*`).
- **Public API-version tracker** — endpoint + page showing which upstream platform API versions each connected account is pinned to, and upcoming sunsets.

Every post submission flows through: **preflight validator → idempotent execution layer → transparent error contract**. The contract always tells the caller what rule failed and attaches the raw platform response.

## Product principles

These are non-negotiable. If a feature breaks one of these, the feature loses.

### 1. Preflight over postflight

Every platform's documented constraints are checked *before* the platform API call. Character counts (LinkedIn's 3000 emoji-aware, Threads' 500, X's 280 / 25k for premium), media formats, URL reachability, video container/codec/duration limits, TikTok upload+publish status polling, URN patterns, business-account requirements, OAuth scopes — all validated client-side. ~95 documented preflight rules across 8 platforms today, each with its own docs page and upstream-source citation. Async rejections from the platform are always treated as *our* failure to preflight, not the user's failure to read docs.

### 2. Transparent errors

No endpoint ever returns `{ body: {}, message: '' }`. Every error response includes:

- A stable, documented letmepost error code
- The specific rule or precondition that failed
- The raw platform response, where available
- A suggested remediation

Direct response to Ayrshare's own admission that their error 138 "masks multiple distinct underlying causes."

### 3. API version abstraction

Platform API versions are pinned, tracked, and abstracted behind our interface. When LinkedIn sunsets a version, we upgrade internally and publish a changelog — user workflows do not break. The public version tracker makes this legible from the outside.

### 4. Idempotency by default

Every `POST /posts` accepts an idempotency key. Retries are safe. This is a first-class contract, not an afterthought — directly answers the Postiz double-posting bug (issue #1321) that the Postiz maintainer flagged as critical.

### 5. Open source, all the way

Core is open source from day one. Hosted SaaS runs the same code. Self-hosters get the same API. No feature gate between OSS and hosted. The hosted tier wins on infrastructure and managed OAuth, not on locked-away features.

### 6. World-class documentation

Documentation is a product surface, not a deliverable. Best-in-class, Stripe-tier — every endpoint has runnable examples in Python / TypeScript / Go / cURL, every error code has its own page with a real-world reproduction and remediation, every preflight rule is documented with the upstream platform source it derives from, and the public API-version tracker doubles as live reference. If a behavior isn't documented, it doesn't exist. Docs ship with the code, not after.

### 7. Design is paramount — UI, UX, and DX

The API contract, the SDK ergonomics, the error messages, the dashboard, the docs site, the onboarding flow, the OAuth redirect experience — all of it. Every surface a developer or operator touches is designed, not accreted. DX leads: naming, response shapes, defaults, and failure messages are treated with the same care as visual polish. No "we'll fix the UX later." Taste is a product requirement.

## Distribution model

**Hosted SaaS** — primary commercial offering. Managed OAuth (publish through our reviewed Meta / LinkedIn / X / TikTok apps, no per-customer App Review), token refresh, infrastructure, webhook delivery, version-pin upgrades. Three tiers, one metered thing — *posts published*:

- **Free** — 50 posts/mo, full API surface, all platforms, no credit card. Indefinite.
- **Pro** — $79/mo for 5,000 posts/mo, 30-day publish logs, all webhook events.
- **Business** — $299/mo for 25,000 posts/mo, white-label OAuth, 99.9% SLA, 180-day publish logs.
- **Business+** — enquiry-driven for volume / SSO / SCIM / custom SLA / white-labelling / DPA.

Profiles are free at every tier. Per-profile and per-seat pricing are *rejected*, not deferred — they are the antithesis of the wedge.

**Self-host** — first-class community option. Docker Compose, bring-your-own-credentials, identical API surface, unlimited posts. `BILLING_ENABLED=false` skips the billing surface entirely. This is how we out-trust Zernio (closed) and out-ship Postiz (unreliable) at the same time.

## Platform scope — v1 is the Publisher

**In scope for v1:** posting, scheduling (queue + cancel + reschedule), media upload, platform-native variants (e.g., IG Reels vs. feed, LinkedIn org vs. personal, X reply chains + quote tweets, Bluesky video service flow, TikTok inbox vs. Direct Post).

**Out of scope for v1** (future bets, not this product yet):

- Inbox: DMs, comments, comment replies, review replies
- Analytics dashboards beyond post-log + error-log
- Ads manager across Meta/Google/LinkedIn/Pinterest/X
- WhatsApp Business (templates, flows, phone numbers — a standalone product)
- CRM-ish features (contacts, sequences, broadcasts)
- Comment-to-DM automations
- YouTube (deferred to v2 in the April 2026 scope update — CASA verification path is real but slow; revisit post-launch)

### Platform list and ship state

| Platform | State | Why it's here |
|---|---|---|
| **Bluesky** | live | First to ship — simple AT protocol, no app review, minutes-long JWT lifecycle was a good forcing function for the token-refresh architecture. |
| **LinkedIn** | live | The wedge platform. #1 complaint volume in the research corpus. Cleanest API of the majors (4.7% fail rate in the Zernio data). Where preflight + version-pinning shows its teeth. |
| **Twitter / X** | live | Table-stakes for the automation-builder ICP. Most-quirky publisher (chunked video upload, t.co counter, reply chains, quote tweets, alt-text on a separate v1.1 endpoint). |
| **Instagram + Facebook + Threads** | live | Meta Graph trio, built together because they share auth. ~51% of post volume and 54k accounts in the Zernio data. App Review cleared. |
| **Pinterest** | live | Fastest-growing platform in the Zernio dataset (+1369% over 90 days), lowest fail rate (3%). Image + video pins with the same media plumbing as Meta. Standard Access cleared. |
| **TikTok** | pending review | Replaced YouTube in the April 2026 scope update. Publisher fully built — OAuth 2.0 PKCE, `push_by_file` inbox upload, status-poll worker. State flips to `live` the moment App Review approves. |

**Deliberately cut from v1:** YouTube (deferred), Reddit (67% fail rate, hostile API), Telegram / Discord / Snapchat / Google Business / WhatsApp (long tail, <1k accounts each in the data).

## How we're different

| vs. | Their weakness | Our wedge |
|---|---|---|
| **Zernio** (closed, positioning-only) | No community trust, closed source, new brand (rebranded from "Late") | Apache 2.0, public code, transparent roadmap |
| **Postiz** (OSS benchmark) | Silent failures, double-posting loops, single-tenant architecture blocks SaaS use | Idempotency keys, preflight validation, multi-tenant from day one |
| **Ayrshare** (category leader) | Per-profile pricing, opaque error 138s, broad OAuth scopes | Flat per-org pricing (Free 50/mo, Pro $79 / 5k, Business $299 / 25k), rule-specific errors, scoped OAuth |
| **Buffer / Publer / Hypefury** (creator tools) | Creator-focused dashboards, no real API, per-channel pricing | API-first primitive, no dashboard tax |
| **Hootsuite / Sprout / Later** (enterprise) | Contract lock-in, per-seat pricing, auto-renewal abuse | No contracts, no seat tax, no lock-in |

**Open-source alone does not win** — Postiz proves it. The winning combination is open source + preflight + transparent errors + idempotency + stable versions + native MCP, positioned to the automation-builder and AI-agent-builder cohort first. Creators come later, via UI partners.

## Resolved questions

What was open in the original draft and is now locked in:

- **Pricing.** Three tiers, flat per-org, metered on *posts published*: Free (50/mo), Pro ($79 / 5k), Business ($299 / 25k), self-host unlimited. Hard cap, no overages — quota.warning fires at 80%, quota.exceeded at 100%, and the post queues rather than publishing. Locked May 2026. Profiles free at every tier.
- **License.** Apache 2.0. Same image self-host vs. hosted.
- **MCP server.** Shipped — hosted (`api.letmepost.dev/mcp`, streamable HTTP, stateless, OAuth 2.1 + DCR) and stdio (`@letmepost/mcp` on npm). 21 tools generated from the OpenAPI spec at startup.
- **CLI.** Shipped — `@letmepost/cli`, `lmp` binary.
- **SDKs.** Shipped — TypeScript (`@letmepost/sdk`, hand-written), Python (`letmepost` on PyPI, generated), Go (`github.com/letmepost/letmepost-go`, generated).

## Still open

- **LangGraph / CrewAI adapters.** Not committed. The native MCP server handles most of the agent-builder ask; framework-specific adapters are demand-driven.
- **Ayrshare SDK drop-in adapter.** Migration lever, not v1 — revisit if outbound to Ayrshare's user base finds heat.
- **TikTok Direct Post (`video.publish`) audit.** Current state — inbox push with `privacy=SELF_ONLY` works in sandbox. Direct Post requires a second audit. Decision to push for it depends on TikTok being a meaningful share of post volume post-launch.

## Related files in this repo

- `plan.md` — what's shipped, what's pending external approval, pre-launch checklist
- `TECH.md` — stack contract
- `CONTRIBUTING.md` — conventions (gate pattern §3.5, PostHog conventions §11)
- `DEPLOY.md` — Railway + Vercel + Mintlify deploy notes
- `docker-compose.dev.yml` — local Postgres + Redis
- `apps/api/src/openapi.json` + `docs/api-reference/openapi.json` — generated OpenAPI surface
- `packages/schemas/src/platform-state.ts` — canonical platform launch state (the connect drawer, marketing site, and backend connect gate all read from here)
