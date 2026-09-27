# letmepost.dev

> **An open-source social media publishing API that fails loudly.**
> One `POST /v1/posts` across every platform. Stable error codes, the rule that failed, the raw platform body, and a remediation — on every failure. Never an empty `{ body: {} }`. No per-profile tax.

An alternative to: **Ayrshare**, **Postiz**, **Buffer**, **Hootsuite**, **Hypefury**.

[![CI](https://img.shields.io/github/actions/workflow/status/letmepost/letmepost.dev/ci.yml?branch=main&style=flat-square&color=2D7A4D&label=ci)](https://github.com/letmepost/letmepost.dev/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@letmepost/sdk?style=flat-square&color=2D7A4D&label=%40letmepost%2Fsdk)](https://www.npmjs.com/package/@letmepost/sdk) [![License](https://img.shields.io/badge/License-Apache_2.0-2D7A4D.svg?style=flat-square)](https://opensource.org/license/apache-2-0) [![Stars](https://img.shields.io/github/stars/letmepost/letmepost.dev?style=flat-square&color=2D7A4D)](https://github.com/letmepost/letmepost.dev/stargazers) [![Issues](https://img.shields.io/github/issues/letmepost/letmepost.dev?style=flat-square&color=2D7A4D)](https://github.com/letmepost/letmepost.dev/issues) [![Good first issues](https://img.shields.io/github/issues/letmepost/letmepost.dev/good-first-issue?style=flat-square&color=7057ff&label=good%20first%20issues)](https://github.com/letmepost/letmepost.dev/issues?q=is%3Aissue+is%3Aopen+label%3Agood-first-issue) [![Docs](https://img.shields.io/badge/docs-letmepost.dev-2D7A4D.svg?style=flat-square)](https://docs.letmepost.dev)

**[Website](https://letmepost.dev)** · **[Docs](https://docs.letmepost.dev)** · **[Quickstart](https://docs.letmepost.dev/quickstart)** · **[Dashboard](https://dashboard.letmepost.dev)** · **[API Reference](https://docs.letmepost.dev/api-reference)**

Supports: Bluesky · LinkedIn · X · Threads · Instagram · Facebook · Pinterest · YouTube

---

## The four guarantees on every request

1. **Preflight, not postflight.** Character counts, media formats, URN patterns, audit states, OAuth scope mismatches, YouTube quota — all validated locally **before** the upstream call.
2. **Transparent errors.** Stable letmepost code + the specific rule that failed + the raw platform body + a remediation hint. Always.
3. **Pinned platform versions.** We pin the header, track deprecations, upgrade internally. Your workflow doesn't break at 2 a.m. when LinkedIn sunsets v202412.
4. **Idempotency by default.** Every write accepts an `Idempotency-Key`. Retries are safe — no double-posting loops when a worker restarts mid-publish.

## What it looks like

**Request:**

```bash
curl -X POST https://api.letmepost.dev/v1/posts \
  -H "Authorization: Bearer lmp_live_…" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "targets": [{ "accountId": "acc_…" }],
    "text": "Shipping letmepost.dev"
  }'
```

**Failure:**

```json
{
  "error": {
    "code": "preflight_failed",
    "rule": "bluesky.text.max_graphemes",
    "platform": "bluesky",
    "platformVersion": "atproto-2026-04",
    "message": "Post text is 312 graphemes; Bluesky allows at most 300.",
    "remediation": "Shorten the post to 300 graphemes or fewer.",
    "docUrl": "https://docs.letmepost.dev/errors/preflight_failed",
    "ruleUrl": "https://docs.letmepost.dev/preflight/bluesky-text-max_graphemes",
    "requestId": "req_01HY6X4AWBJM2K9F2PTQMRD9JQ"
  }
}
```

Same shape across every platform. Same shape on every error class — `preflight_failed`, `platform_auth_failed`, `platform_rejected`, `platform_unavailable`, `rate_limited`. The dashboard renders these directly. Your error handler doesn't need a per-platform branch.

## Why this exists

Four things developers hit every week with incumbent social-media APIs:

1. **Silent failures.** Posts report success then never appear. Error bodies come back as `{}`. Postiz [#1321](https://github.com/gitroomhq/postiz-app/issues/1321) was an infinite double-post loop; Ayrshare's error 138 masks half a dozen distinct upstream causes.
2. **API version churn.** LinkedIn sunset **five API versions in six months** in 2024–2025; every sunset broke n8n Cloud, Zapier, Make, Pabbly, and Postiz. The fix in every case was a one-header swap.
3. **Async media rejections.** YouTube's restricted-scope mismatches surfacing as generic `forbidden`, Threads's `OAuthException 2207052`, Instagram Reels rejecting Google Drive URLs — all catchable client-side, all unhandled by the incumbents.
4. **Per-profile pricing.** $6–$12 per channel, per month, forever. Universally hated; nobody has built around it. We don't charge it.

letmepost.dev addresses all four, in one API.

## Platform support

| Platform | Status | Notes |
|---|---|---|
| **Bluesky** | live | App-password auth, video via dedicated transcoder, 300-grapheme preflight |
| **X / Twitter** | trial | OAuth 2.0 PKCE, 280 graphemes (t.co-aware), 4 images OR 1 video, threads & quote tweets |
| **Pinterest** | trial | v5 API, image + video pins, board-required preflight |
| **LinkedIn** | pending | Versioned REST, 3,000-grapheme commentary, MDP-gated for org posts |
| **Threads** | pending | Standalone OAuth at threads.net, 500-char, 2–20 mixed-media carousels |
| **Instagram** | pending | Meta Graph, Reels + carousels, FB Login fan-out |
| **Facebook Pages** | pending | Meta Graph, single video OR 10 photos |
| **YouTube** | planned | Data API v3, CASA-gated for production verification |

**`live`** = production-ready end-to-end. **`trial`** = connect works but rate-limited or sandboxed (X on Pay-Per-Use, Pinterest on Trial Access). **`pending`** = approval in flight; the publisher is built and ships the moment review clears. **`planned`** = built into the schema, publisher pending.

TikTok is deferred to v2 — schemas + DB enum keep it reserved so the v2 add is additive. Reddit, Telegram, Discord, Snapchat, Google Business, and WhatsApp are deliberately cut from v1. Reasoning in [`PRODUCT.md`](./PRODUCT.md).

## Quickstart

```bash
# 1. Sign up + grab a key
open https://dashboard.letmepost.dev

# 2. Connect Bluesky (or any other platform via OAuth)
curl -X POST https://api.letmepost.dev/v1/accounts/connect/bluesky \
  -H "Authorization: Bearer lmp_live_…"

# 3. Publish
curl -X POST https://api.letmepost.dev/v1/posts \
  -H "Authorization: Bearer lmp_live_…" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "targets": [{ "accountId": "acc_…" }], "text": "Hello, world" }'
```

90-second walkthrough at [docs.letmepost.dev/quickstart](https://docs.letmepost.dev/quickstart).

## Contributing

We build in the open. Outside contributions are how this becomes a primitive for **every** social platform, not just the eight we shipped first.

**Pick a starting point:**

- **[Good first issues](https://github.com/letmepost/letmepost.dev/issues?q=is%3Aissue+is%3Aopen+label%3Agood-first-issue)** — scoped, isolated, no DB-migration archeology required.
- **[Help wanted](https://github.com/letmepost/letmepost.dev/issues?q=is%3Aissue+is%3Aopen+label%3Ahelp-wanted)** — medium tasks the maintainers can't get to.
- **[Platform requests](https://github.com/letmepost/letmepost.dev/issues?q=is%3Aissue+is%3Aopen+label%3Atype%3Aplatform)** — Reddit, Mastodon, YouTube, Telegram, Discord, Google Business. Each issue mirrors the same publisher shape (provider + publisher + preflight + client). The walkthrough in [`CONTRIBUTING.md` §3](./CONTRIBUTING.md#3-platform-addition) is the canonical recipe — most additions are < 500 LOC.
- **Found a bug?** Open one via the [bug-report template](https://github.com/letmepost/letmepost.dev/issues/new?template=bug_report.yml) — auto-applies the right labels and asks for the platform + repro + raw error envelope so triage doesn't ping-pong.

**Before you open a PR**, skim [`CONTRIBUTING.md`](./CONTRIBUTING.md) — it documents the layering rules, the error contract, the pre-publish gate pattern, the testing approach (MSW + transaction rollback), and the commit style we follow. It's how new code reviews itself.

[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) · [`SECURITY.md`](./SECURITY.md) (vulnerability disclosure) · [`PRODUCT.md`](./PRODUCT.md) (the seven product principles) · [`TECH.md`](./TECH.md) (stack contract) · [`plan.md`](./plan.md) (v1 status + pre-launch checklist).

## Self-host

Apache 2.0 from day 0. The same code that runs `api.letmepost.dev` runs on your own infra — no feature gate, no open-core trick.

```bash
git clone https://github.com/rosekamallove/letmepost.dev
cd letmepost.dev
pnpm install
cp apps/api/.env.example apps/api/.env             # fill in your platform OAuth credentials
docker compose -f docker-compose.dev.yml up -d     # spins up Postgres + Redis only
pnpm --filter @letmepost/api db:migrate
pnpm dev                                           # API + dashboard in watch mode
```

The dev compose file ships Postgres + Redis. The API, worker, and dashboard run via `pnpm` — see [docs.letmepost.dev/self-host/quick-start](https://docs.letmepost.dev/self-host/quick-start) for the full walkthrough and [self-host/deploying](https://docs.letmepost.dev/self-host/deploying) for production patterns. BYO Postgres (or Neon), BYO Redis (or Upstash), BYO platform credentials. Hosted is permanently optional.

## Running locally (development)

**Prerequisites:** Node `>=24`, pnpm `10.33.0+` (`corepack enable`).

```bash
pnpm install
pnpm dev            # API + web + dashboard in watch mode (turbo)
pnpm test           # vitest across the workspace
pnpm typecheck
pnpm build
```

**Individual apps:**

```bash
pnpm --filter @letmepost/api dev        # API → http://localhost:3000
pnpm --filter @letmepost/dashboard dev  # Dashboard → http://localhost:3001
pnpm --filter @letmepost/web dev        # Landing → http://localhost:4321
```

## Repo layout

```
apps/
  api/                 # Hono HTTP API + BullMQ workers — the core product
  dashboard/           # Next.js operator surface (dashboard.letmepost.dev)
  web/                 # Astro landing site (letmepost.dev)
packages/
  schemas/             # Zod — single source of truth for validation, types, OpenAPI
  sdk-ts/              # @letmepost/sdk — official TypeScript client (npm)
  config-tsconfig/
```

Landing as the stack grows: `packages/openapi/` (generated 3.1 spec), plus sibling repos `letmepost/sdk-python` and `letmepost/sdk-go` auto-generated from the spec. See [`TECH.md`](./TECH.md) for the full target tree.

## Tech stack

Hono · BullMQ · Drizzle · PostgreSQL (Neon) · Redis (Upstash) · better-auth · Zod · Next.js · Astro · TypeScript · Turborepo · pnpm.

API contract details in [`TECH.md`](./TECH.md). Product principles in [`PRODUCT.md`](./PRODUCT.md). Roadmap in [`plan.md`](./plan.md).

## Compliance

- letmepost.dev is an open-source, self-hosted-capable social media publishing API.
- The hosted service uses **official, platform-approved OAuth flows** for every platform (Bluesky app-password is the documented Bluesky-supported alternative; everything else is OAuth 2.0 or OAuth 2.0 + PKCE).
- letmepost.dev **does not scrape** content from social media platforms — every read or write is through the platform's documented API.
- letmepost.dev **does not collect, store, or proxy** API keys or access tokens belonging to the integrating developer's end-users. Users authenticate directly with the social platform; tokens are AES-256-GCM encrypted at rest with per-row data keys.
- letmepost.dev **never asks users to paste API keys** into the hosted product UI.
- Self-host users supply their own platform credentials; no telemetry, no license check, no phone-home.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=rosekamallove/letmepost.dev&type=Date)](https://www.star-history.com/#rosekamallove/letmepost.dev&Date)

## License

[Apache 2.0](./LICENSE). Permissive by design — you can build a commercial product on top of letmepost.dev without copyleft contagion. Same code in hosted and self-host.
