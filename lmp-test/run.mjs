#!/usr/bin/env node
/**
 * lmp-test — smoke tests for the live letmepost.dev API.
 *
 * Runs against whatever `API_URL` points at (default: https://api.letmepost.dev)
 * using an API key from `LMP_API_KEY`. Skips any section whose accounts aren't
 * configured so a partial-setup machine still exercises what it can.
 *
 * Sections in this file:
 *   1. Single-target publish (one-element `targets[]`) + platform-only
 *      auto-resolution.
 *   2. Multi-target fan-out across two connected accounts.
 *   3. Validation rejections (mode conflict, empty targets[], options
 *      platform mismatch, v0 `account: {}` shape).
 *
 * Run:  pnpm test  (from `lmp-test/`)
 *
 * Env:
 *   API_URL                  base URL (defaults to https://api.letmepost.dev)
 *   LMP_API_KEY              Bearer api key (required)
 *   LMP_BLUESKY_ACCOUNT_ID   uuid of a connected Bluesky platform_account
 *   LMP_THREADS_ACCOUNT_ID   uuid of a connected Threads platform_account
 *   LMP_TWITTER_ACCOUNT_ID   uuid of a connected Twitter/X platform_account
 */

const API_URL = process.env.API_URL ?? "https://api.letmepost.dev";
const API_KEY = process.env.LMP_API_KEY;
const BLUESKY_ID = process.env.LMP_BLUESKY_ACCOUNT_ID;
const THREADS_ID = process.env.LMP_THREADS_ACCOUNT_ID;
const TWITTER_ID = process.env.LMP_TWITTER_ACCOUNT_ID;

const passed = [];
const failed = [];
const skipped = [];

function uuid() {
  // Node 19+ has crypto.randomUUID on globalThis.crypto.
  return globalThis.crypto.randomUUID();
}

async function post(path, body, extraHeaders = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "Idempotency-Key": uuid(),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body — leave json null
  }
  return { status: res.status, body: json };
}

async function test(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed.push({ name, err });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message ?? err}`);
  }
}

function skip(name, why) {
  skipped.push({ name, why });
  console.log(`  --  ${name}  (skip: ${why})`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!API_KEY) {
    // Soft-skip when env isn't configured so the smoke runner is harmless
    // in CI matrices that don't have a live key. Failing here would block
    // unrelated workflows (typecheck, lint) on incidental config drift.
    console.log("LMP_API_KEY not set — skipping all smoke tests.");
    return;
  }

  console.log(`# single-target publish`);
  if (BLUESKY_ID) {
    await test("single-target bluesky publish", async () => {
      const res = await post("/v1/posts", {
        targets: [{ accountId: BLUESKY_ID }],
        text: `lmp-test single ${new Date().toISOString()}`,
      });
      assert(
        res.status === 200,
        `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
      );
    });

    await test("platform-only auto-resolution", async () => {
      const res = await post("/v1/posts", {
        targets: [{ platform: "bluesky" }],
        text: `lmp-test auto-resolve ${new Date().toISOString()}`,
      });
      // Either 200 (unique account) or 400 with target.account.ambiguous /
      // target.account.not_connected — both confirm the resolver works.
      assert(
        res.status === 200 ||
          (res.status === 400 &&
            (res.body?.error?.rule === "target.account.ambiguous" ||
              res.body?.error?.rule === "target.account.not_connected")),
        `unexpected response: ${res.status} ${JSON.stringify(res.body)}`,
      );
    });
  } else {
    skip("single-target bluesky publish", "LMP_BLUESKY_ACCOUNT_ID unset");
    skip("platform-only auto-resolution", "LMP_BLUESKY_ACCOUNT_ID unset");
  }

  console.log(`\n# multi-target fan-out`);

  if (BLUESKY_ID && THREADS_ID) {
    await test("two targets in one request (bluesky + threads)", async () => {
      const res = await post("/v1/posts", {
        targets: [
          { accountId: BLUESKY_ID },
          { accountId: THREADS_ID },
        ],
        text: `lmp-test multi ${new Date().toISOString()}`,
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(Array.isArray(res.body?.results), "results must be an array");
      assert(
        res.body.results.length === 2,
        `expected 2 results, got ${res.body.results.length}`,
      );
      assert(
        typeof res.body.id === "string" && res.body.id.length > 0,
        "batch id missing",
      );
    });

    await test("per-target text override", async () => {
      const res = await post("/v1/posts", {
        targets: [
          { accountId: BLUESKY_ID, text: "bluesky-specific copy" },
          { accountId: THREADS_ID, text: "threads-specific copy" },
        ],
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.body.results?.length === 2, "expected 2 results");
    });

    await test("per-target media override (text-only fallback)", async () => {
      // We don't ship binary media here; just exercise the override path
      // with media absent on each target — the top-level text is what each
      // target inherits, so this should publish text-only on both.
      const res = await post("/v1/posts", {
        targets: [
          { accountId: BLUESKY_ID },
          { accountId: THREADS_ID, text: "explicit override" },
        ],
        text: `lmp-test media-override ${new Date().toISOString()}`,
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
    });
  } else {
    skip("two targets in one request (bluesky + threads)", "need both BLUESKY_ACCOUNT_ID + THREADS_ACCOUNT_ID");
    skip("per-target text override", "need both BLUESKY_ACCOUNT_ID + THREADS_ACCOUNT_ID");
    skip("per-target media override (text-only fallback)", "need both BLUESKY_ACCOUNT_ID + THREADS_ACCOUNT_ID");
  }

  if (BLUESKY_ID) {
    await test("mode conflict rejection (publishNow + scheduledAt)", async () => {
      const res = await post("/v1/posts", {
        targets: [{ accountId: BLUESKY_ID }],
        text: "mode-conflict test",
        publishNow: true,
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert(res.status === 400, `expected 400, got ${res.status}`);
      assert(
        res.body?.error?.code === "validation_failed",
        `expected validation_failed, got ${res.body?.error?.code}`,
      );
      assert(
        res.body?.error?.rule === "mode_conflict",
        `expected rule mode_conflict, got ${res.body?.error?.rule}`,
      );
    });

    await test("empty targets[] rejection", async () => {
      const res = await post("/v1/posts", {
        targets: [],
        text: "no targets",
      });
      assert(res.status === 400, `expected 400, got ${res.status}`);
    });

    // Regression: v0 single-target `account: { platform, id }` body was
    // accepted via legacy compat in early dx-overhaul iterations, then
    // intentionally dropped. Assert it now fails cleanly so a future PR
    // can't accidentally reintroduce the back-compat.
    await test("v0 account-body shape is rejected with a clear error", async () => {
      const res = await post("/v1/posts", {
        account: { platform: "bluesky", id: BLUESKY_ID },
        text: "v0 shape regression",
      });
      assert(res.status === 400, `expected 400, got ${res.status}`);
      assert(
        res.body?.error?.code === "validation_failed",
        `expected validation_failed, got ${res.body?.error?.code}`,
      );
    });

    if (TWITTER_ID) {
      await test("options.platform_mismatch rejection", async () => {
        const res = await post("/v1/posts", {
          targets: [
            {
              accountId: BLUESKY_ID,
              // Sending Twitter options to a Bluesky target → 400.
              options: { platform: "twitter", replyToTweetId: "123" },
            },
          ],
          text: "platform-mismatch test",
        });
        assert(res.status === 400, `expected 400, got ${res.status}`);
        assert(
          res.body?.error?.rule === "targets.options.platform_mismatch",
          `expected rule targets.options.platform_mismatch, got ${res.body?.error?.rule}`,
        );
      });
    } else {
      skip("options.platform_mismatch rejection", "LMP_TWITTER_ACCOUNT_ID unset (only needed for the case label)");
    }
  } else {
    skip("mode conflict rejection (publishNow + scheduledAt)", "LMP_BLUESKY_ACCOUNT_ID unset");
    skip("empty targets[] rejection", "LMP_BLUESKY_ACCOUNT_ID unset");
    skip("v0 account-body shape is rejected with a clear error", "LMP_BLUESKY_ACCOUNT_ID unset");
    skip("options.platform_mismatch rejection", "LMP_BLUESKY_ACCOUNT_ID unset");
  }

  console.log(`\nresults:`);
  console.log(`  passed:  ${passed.length}`);
  console.log(`  failed:  ${failed.length}`);
  console.log(`  skipped: ${skipped.length}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("lmp-test crashed:", err);
  process.exit(1);
});
