# letmepost.dev — tech stack

Implementation-level decisions. Paired with `PRODUCT.md` (the what / why / for-whom). This doc is the what-we-build-it-with.

TypeScript throughout the stack. TDD is mandatory — every API endpoint has multiple tests covering happy path plus edge cases before the endpoint is considered done.

## Decisions

| Concern | Pick | One-liner why |
|---|---|---|
| Repo layout | **Monorepo** | Schemas, OpenAPI spec, SDK types, and docs must evolve atomically; cross-repo version skew would break the preflight-validation contract. |
| Monorepo tool | **Turborepo** | Zero conceptual overhead, Next.js-friendly, free self-hosted remote cache, affected-only test runs fit the TDD loop. |
| Package manager | **pnpm** | 2026 default for TS monorepos; richest `--filter` semantics; Turborepo's docs assume it. |
| API framework | **Hono** + `@hono/zod-openapi` | Runtime-agnostic (Node / Bun / Workers), in-memory `app.request()` testing, Zod-to-OpenAPI pipeline is the cleanest single-source-of-truth for schemas → validation → TS types → spec. |
| Validation | **Zod** | Single source of truth for runtime validation, TS types, and OpenAPI spec. Matches the preflight-validation product principle 1:1. |
| Dashboard | **Next.js** (App Router) | Already decided; simple admin surface. |
| Landing + docs site | **Astro** + **Starlight** (single app, `/docs` sub-route) | SEO is a core product bet. Astro ships zero JS by default — Lighthouse 100s are routine. Starlight (by the Astro core team) gives Stripe-tier docs typography and search in the same deploy as marketing. Unified sitemap, shared design system, internal link equity. |
| API reference rendering | **Scalar**, embedded inside the Starlight docs site | Renders the OpenAPI spec as the interactive reference pages. Keeps narrative guides (Starlight) and reference (Scalar) on one domain, one auth, one sitemap. |
| Test runner | **Vitest** | Fast watch mode, first-class Hono support, snapshot + coverage built in. |
| External HTTP mocking | **MSW** (Mock Service Worker) | Intercepts `fetch` globally; the modern replacement for `nock`; same mocks usable in Node tests and browser previews. |
| Versioning | **Changesets** | For `sdk-ts` and `cli` publish flow. |
| Python / Go SDKs | **Separate repos**, auto-generated from the OpenAPI spec | `pip install` and `go get` have to work the idiomatic way; Python/Go contributors shouldn't need Node. Monorepo CI regenerates and PRs to the sibling repos. |
| CI cache | **GitHub Actions cache** initially → **self-hosted** (`ducktors/turborepo-remote-cache` on Cloudflare R2) once cache churn bites. | OSS-friendly, no Vercel lock-in. |
| Database | **NeonDB** (Postgres) | Serverless Postgres, branch-per-preview for CI, vendor-neutral (it's just Postgres — self-hosters can point at any Postgres). |
| ORM | **Drizzle** (use the relational queries API) | TS-native, no codegen step, schema lives in `.ts` files. Relational queries API (`db.query.*.findMany({ with: ... })`) is Prisma-adjacent ergonomics with none of the Prisma client overhead. |
| Job queue | **BullMQ** on **Upstash Redis** | MIT. Upstash free tier covers early traffic; ~$5/mo tier when outgrown. Rejected pg-boss because Neon's serverless connection model fights LISTEN/NOTIFY. |
| Auth | **better-auth** | First-class TypeScript, API keys plugin (unifies dashboard sessions + public API auth), organizations plugin for future agency tier, fully self-hostable. Familiar from adjacent work — velocity advantage. |
| API hosting | **Railway** | Already running other products there; solid for long-lived Node processes, built-in Postgres/Redis addons, straightforward deploys. Dashboard and web site deploy separately (Vercel or Cloudflare Pages). |
| Token encryption | **AES-256-GCM envelope encryption** via Node `crypto`, master key in Railway env vars | Cryptographically sound, zero extra infra. DEK per token, KEK encrypts DEKs, supports cheap master-key rotation. Upgrade path: move KEK to **AWS KMS** or **Cloudflare KMS** when compliance asks for it — wrapping code stays identical. |
| Errors | **Sentry** | Official Hono SDK, free tier covers early stage. |
| Logs + traces | **Axiom** via **OpenTelemetry** SDK | OTel keeps instrumentation vendor-agnostic; Axiom treats logs and traces as one dataset with 500 GB/mo free. |
| Rate limiting | **`@upstash/ratelimit`** on the same Upstash Redis as BullMQ | Two-layer: per-API-key quotas + per-IP floor for unauthenticated endpoints. Railway has no built-in rate limiter. Cloudflare in front is the DDoS-protection upgrade path (DNS-only change, no code). |

## Directory layout

```
letmepost.dev/
├── apps/
│   ├── api/              # Hono — the core product
│   ├── dashboard/        # Next.js — account management
│   └── web/              # Astro + Starlight — landing + docs + API reference
├── packages/
│   ├── schemas/          # Zod — single source of truth
│   ├── openapi/          # Generated OpenAPI 3.1 spec
│   ├── sdk-ts/           # @letmepost/sdk — published to npm
│   ├── ui/               # shadcn-based design tokens shared by dashboard + web
│   ├── config-eslint/
│   ├── config-tsconfig/
│   └── cli/              # Optional dev CLI
├── .github/workflows/
│   ├── ci.yml            # test + lint + typecheck, affected-only
│   ├── release.yml       # changesets publish
│   └── sdk-sync.yml      # regen Python/Go SDKs, PR to sibling repos
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

Sibling repos under the same GitHub org:
- `letmepost/sdk-python` — auto-PR'd from `packages/openapi/` on change
- `letmepost/sdk-go` — auto-PR'd from `packages/openapi/` on change

## Testing philosophy

Non-negotiable, stated here so future sessions can't re-litigate without a reason:

1. **Every API endpoint has tests before the endpoint is considered done.** No "I'll add tests later."
2. **Multi-case coverage per endpoint.** At minimum: happy path, invalid input (per field), unauthorized, idempotency replay, upstream-platform failure, upstream-platform malformed response, rate-limited.
3. **Preflight rules are tested independently of the handler.** A rule like "Instagram Reels ≤ 8MB" is a pure function with its own unit-test suite. The handler test confirms the rule is wired in.
4. **External platform HTTP is always mocked via MSW.** No tests hit real Meta / LinkedIn / YouTube APIs. Separately, a small `contract/` suite runs against real APIs on a cron to catch upstream regressions — that one is not in the TDD loop.
5. **In-memory requests only in the fast suite.** `app.request()` — no port binding, no supertest. The framework call is sub-millisecond; full tests with setup/teardown typically land at 5–50 ms each. Target the whole API suite running locally in seconds, not minutes — if it drifts above that, something is wrong.
6. **Affected-only in CI.** `turbo run test --filter='...[origin/main]'` — don't re-run the world on every PR.

## Things we'll hit and accept

- **Turborepo's change detection is file-hash, not import-graph** — touching a root config invalidates everything. Rare but annoying.
- **Astro + Next.js means two frameworks to maintain.** The shared `packages/ui` reduces the drift but doesn't eliminate it.
- **Hono's plugin ecosystem is younger than Fastify's.** For niche needs (advanced rate limiting, queue integration) we may write middleware ourselves. Acceptable trade for the cleaner OpenAPI pipeline and runtime flexibility.
- **GitHub Actions cache has a 10 GB per-repo limit and evicts aggressively.** Plan to move to self-hosted cache when it bites.
- **Python/Go SDKs in separate repos means atomic-change story has a seam.** A breaking OpenAPI change lands in the monorepo before the SDK repos update. Acceptable — the alternative is forcing polyglot contributors to install Node.

## What we considered and rejected

- **Fastify** (API) — more mature plugin ecosystem, but Node-only and noisier OpenAPI pipeline. Strong runner-up if a niche Node plugin need pulls us.
- **Elysia + Bun** (API) — genuinely excellent DX and best-in-class TS inference. Rejected because (a) Hono has a materially larger production footprint and ecosystem in 2026, and (b) the perf argument that favors Elysia in synthetic benchmarks is irrelevant to our workload — upstream platform API latency (200–2000 ms per post) dominates end-to-end by 99%+, so framework req/s is not a meaningful axis. Not rejected because of self-host friction; Docker resolves that.
- **NestJS** (API) — decorator-driven OpenAPI creates drift between validator classes, TS types, and the spec, which directly conflicts with our "schemas are the single source of truth" principle. Additionally: DI + module system is drag on solo-dev velocity at 30–50 endpoints, and Docker image weight matters for self-hosters.
- **tRPC / ts-rest** (API) — wrong shape; we're publishing a REST API for third-party developers, not an internal client.
- **Express** (API) — no type story, no validation, no OpenAPI without heavy glue. Not competitive in 2026.
- **Next.js + Fumadocs** (landing + docs) — strong alternative if the landing site were to grow heavy interactive surfaces. Revisit if that happens.
- **Mintlify** (docs) — gorgeous but hosted SaaS with vendor lock-in; PR-based docs workflow for an OSS project needs files in the repo.
- **Nextra / Docusaurus** (docs) — momentum has moved to Starlight and Fumadocs.
- **Nx** (monorepo) — overkill at our scale.
- **Moon** (monorepo) — interesting but ecosystem gravity is Turbo's.
- **Bun workspaces** (monorepo) — fast install but pnpm is still the safer 2026 default. Bun may come in as a test runner inside individual packages.
