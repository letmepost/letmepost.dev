# Feature request: real sandbox mode for `lmp_test_` keys

**Status:** ready to implement
**Priority:** P0 for the docs correction, P1 for the feature
**Requested by:** a live user (Gerard), who asked for "a test key so I can test endpoint calls without actually scheduling or posting… without using credits or posting to connectors."

---

## TL;DR

The `lmp_test_` key prefix exists throughout the schema, dashboard, and docs, but it is **cosmetic**. Test keys behave identically to live keys: they write to real platforms and consume real quota.

The docs state the opposite, and state it as a *safety guarantee*. A user who trusts the docs will mint a test key, run their integration suite, and post to their real social accounts.

Two pieces of work:

1. **P0 (today, minutes):** correct the documentation so it stops promising isolation that does not exist.
2. **P1 (this week):** implement actual sandbox behavior, then restore the documentation.

---

## Current state — verified

### The prefix is defined and plumbed as data

- `packages/schemas/src/api-keys.ts:3` — `ApiKeyPrefix = z.enum(["lmp_live_", "lmp_test_"])`
- `apps/dashboard/src/app/(app)/api-keys/page.tsx:220` — dashboard offers a **Test** option when minting
- `apps/dashboard/src/app/(app)/api-keys/page.tsx:102,162` — renders `prefix === "lmp_live_" ? "live" : "test"` as a label
- `apps/api/src/routes/api-keys.ts:106,125` — the `prefix` column is stored and returned

### …but nothing enforces it

- `apps/api/src/middleware/api-key-or-session.ts:35-38` — `lmp_live_` and `lmp_test_` fall into the **same branch**, same hash lookup, same context construction. The prefix check only answers "is this an API key at all."
- `apps/api/src/middleware/api-key.ts:7-10` — `ApiKeyContext` is `{ organizationId, apiKeyId, scopes, profileId? }`. **There is no environment/prefix field**, so downstream code cannot distinguish test from live even if it wanted to.
- A repo-wide grep for `.prefix` outside tests returns only display and CRUD usage. No publish, quota, or write path reads it.

### The docs promise otherwise

| File | Claim | True? |
|---|---|---|
| `docs/authentication.mdx:7` | "Keys are prefixed by environment so a `lmp_test_…` key cannot accidentally write to production data" | **No** |
| `docs/authentication.mdx:23` | table row: `lmp_test_…` → sandbox → "hits sandbox accounts; rejects live writes" | **No** |
| `docs/quickstart.mdx:15` | "`lmp_test_…` (sandbox)" | Misleading |
| `docs/errors/unauthenticated.mdx:14` | implies prefix/environment mismatch is rejected | **No** |
| `docs/api-reference/openapi.json:54` | `bearerFormat: "lmp_live_… or lmp_test_…"` | Fine as-is |

---

## Part 1 — P0: stop the bleeding (do this first, ship independently)

Correct every claim in the table above to describe current reality. Suggested replacement for `docs/authentication.mdx`:

> Keys carry an environment prefix — `lmp_live_…` and `lmp_test_…`. **Today the prefix is a label for your own organization: both types have identical permissions and both write to live platforms.** Sandbox isolation is in progress; until it ships, do not point a test suite at a `lmp_test_` key expecting it to be inert.

Same correction wherever the sandbox behavior is implied. This is a few minutes of work and must not wait for Part 2.

### Decision required before hardening

The "correct" fix would be to make `lmp_test_` keys reject live writes immediately. **Do not do this without checking blast radius first** — anyone currently using a test key in production would break instantly.

Run this before deciding:

```sql
SELECT id, organization_id, last_used_at
FROM api_keys
WHERE prefix = 'lmp_test_' AND revoked_at IS NULL AND last_used_at > now() - interval '30 days'
ORDER BY last_used_at DESC;
```

If the result is empty, hardening is safe and can ship with Part 2. If not, those orgs need an email before anything changes.

---

## Part 2 — P1: implement sandbox mode

### Goal

A `lmp_test_` key lets a developer exercise the full API surface — auth, validation, preflight, error shapes, response shapes, webhooks — **without any platform write and without consuming quota.**

### Behavior spec

| Concern | Sandbox behavior |
|---|---|
| Auth | Identical. Invalid/revoked keys still 401. |
| Scopes | Enforced identically. |
| Validation + preflight | **Runs in full.** All 80 preflight rules execute against the real target account's real constraints. This is the main value — real validation is what the user is testing. |
| Platform write | **Never.** Short-circuit before any outbound call. |
| Quota | **Never incremented.** Skip `checkAndIncrementQuota`. |
| Persistence | Post/target rows **are** written, flagged as sandbox, so logs and idempotency behave realistically. |
| Response shape | Byte-identical in shape to live, including per-target `results[]`. Platform IDs/URLs are clearly synthetic (e.g. `sandbox_…`). |
| Errors | Real. A preflight failure in sandbox must produce the exact error a live call would. |
| Webhooks | Fire, with a sandbox marker in the payload, so users can test their handlers. |
| Media upload | Unchanged — uploads are already free and don't meter (`apps/web/data/api-content.ts:561`). |

### Integration points

The publish flow in `apps/api/src/routes/posts.ts` already separates validation from dispatch, which makes this clean:

- `preflightForAccount` — `apps/api/src/platforms/_shared/dispatch.ts:150` — **keep running**
- `publishAcrossTargets` — `apps/api/src/platforms/_shared/dispatch.ts:117` — **short-circuit in sandbox**
- `checkAndIncrementQuota` / `decrementQuota` — `apps/api/src/billing/quota.ts:24,127` — **skip in sandbox**
- Scheduled path enqueues via `apps/api/src/queue/enqueue.ts` → `apps/api/src/queue/publish-processor.ts`

### Implementation steps

1. **Thread the environment through auth.** Add `environment: "live" | "sandbox"` to `ApiKeyContext` (`apps/api/src/middleware/api-key.ts:7`), derived from the stored `prefix` column — **not** from the presented string. Set it in both `api-key.ts` and `api-key-or-session.ts`. Dashboard sessions are `"live"`.

2. **Add a sandbox dispatch branch.** In `publishAcrossTargets` (or at its call site in `posts.ts`), when `environment === "sandbox"`, return synthetic per-target results after preflight instead of calling the platform client. Keep the return type identical so nothing downstream needs to know.

3. **Skip metering.** Guard the `checkAndIncrementQuota` call in `posts.ts` on `environment === "live"`.

4. **Mark the records.** Add a `sandbox boolean not null default false` column to the posts/targets tables; set it from the key environment. Surface it in the dashboard logs view so sandbox traffic is visually distinct and doesn't look like production activity.

5. **Handle the scheduled path.** Sandbox scheduled posts should still enqueue and still fire on time, with the processor taking the same sandbox short-circuit at fire time. This lets users test scheduling end-to-end — which is exactly what broke for the other customer this week, so it needs to be testable.

6. **Isolate by environment.** Sandbox writes must never appear in live analytics, billing counts, or quota reads.

### Open decisions

- **What do sandbox posts target?** The docs currently say test keys "hit sandbox accounts," but no sandbox-account concept exists. **Recommendation:** sandbox keys operate against the org's real connected accounts but never write to them. Simpler, and it matches what the user actually asked for. Update the docs to match rather than building synthetic accounts.
- **Rate limits in sandbox:** suggest keeping them, so users discover limits in testing rather than production.
- **Sandbox quota:** suggest unlimited. Sandbox posts cost nothing to serve, whereas live free-tier posts have real COGS (X posting runs through letmepost's Pay-Per-Use pool, `apps/web/data/platform-content.ts:311`).

### Tests

- A `lmp_test_` key cannot produce an outbound platform call — assert at the HTTP client boundary, not just on response shape.
- Quota is unchanged after N sandbox publishes.
- Preflight failures return identical error bodies in both environments.
- Scheduled sandbox post fires on schedule and writes no platform call.
- A `lmp_live_` key is completely unaffected by all of the above.

### Then restore the docs

Once shipped, rewrite `docs/authentication.mdx`, `docs/quickstart.mdx`, and `docs/errors/unauthenticated.mdx` to describe the real behavior, and add a short `docs/sandbox.mdx` covering what is and isn't simulated. Add a changelog entry.

---

## Follow-up: audit docs against code

This is the **second** documented-but-unenforced claim found this week. The other: the homepage promises "It fails loudly, never silently" (`apps/web/app/page.tsx:33`) while a customer hit posts queued with no delivery attempt and server errors that still created records — and requested a refund citing that exact copy.

Both have the same root cause: docs and marketing describe the intended product, and there's no mechanism catching drift when the implementation lags.

Worth a separate pass: enumerate every *behavioral guarantee* in `docs/` and on the marketing site, and verify each against code or a test. Prioritize claims that are **safety guarantees** — the ones where a user who believes them takes an irreversible action. This spec's `lmp_test_` claim is exactly that class.
