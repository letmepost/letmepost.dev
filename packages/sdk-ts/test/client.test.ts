/**
 * Smoke tests for the SDK. Uses the built-in `node:test` runner so we don't
 * pull in vitest just for the SDK package. Run with:
 *
 *   node --test --import tsx packages/sdk-ts/test/client.test.ts
 *
 * (Or: build the package then `node --test packages/sdk-ts/dist/...` once
 * the test file lives next to the compiled output. For now these are kept
 * as a reference suite; they aren't wired into CI yet.)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

import { Letmepost } from "../src/client.js";
import {
  LetmepostError,
  PreflightFailedError,
  RateLimitedError,
  UnauthenticatedError,
} from "../src/errors.js";
import { verifyWebhook, verifyWebhookSignature } from "../src/webhooks.js";

type Recorder = {
  calls: Array<{ url: string; init: RequestInit }>;
  responses: Array<() => Response>;
};

function mockFetch(rec: Recorder): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    rec.calls.push({ url, init: init ?? {} });
    const next = rec.responses.shift();
    if (!next) throw new Error("no mock response queued");
    return next();
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("posts.create sends bearer + idempotency key and parses response", async () => {
  const rec: Recorder = {
    calls: [],
    responses: [
      () =>
        jsonResponse(
          {
            id: "post_1",
            status: "published",
            createdAt: "2026-05-21T00:00:00.000Z",
            results: [],
          },
          200,
          { "x-request-id": "req_test_1" },
        ),
    ],
  };
  const lmp = new Letmepost({
    apiKey: "lmp_test_abc",
    fetch: mockFetch(rec),
    retries: 0,
  });
  const res = await lmp.posts.create({
    targets: [{ platform: "bluesky" }],
    text: "hi",
  });
  assert.equal(res.id, "post_1");
  const call = rec.calls[0]!;
  assert.equal(call.url, "https://api.letmepost.dev/v1/posts");
  const headers = call.init.headers as Headers;
  assert.equal(headers.get("authorization"), "Bearer lmp_test_abc");
  assert.equal(headers.get("content-type"), "application/json");
  assert.ok(headers.get("idempotency-key"));
});

test("non-2xx with envelope maps to the right error subclass", async () => {
  const rec: Recorder = {
    calls: [],
    responses: [
      () =>
        jsonResponse(
          {
            error: {
              code: "preflight_failed",
              message: "Bluesky text too long",
              rule: "bluesky.text.max_graphemes",
              docUrl: "https://docs.letmepost.dev/errors/preflight_failed",
              requestId: "req_test_2",
            },
          },
          400,
        ),
    ],
  };
  const lmp = new Letmepost({
    apiKey: "lmp_test_abc",
    fetch: mockFetch(rec),
    retries: 0,
  });
  await assert.rejects(
    () => lmp.posts.create({ targets: [{ platform: "bluesky" }], text: "x".repeat(1000) }),
    (err: unknown) => {
      assert.ok(err instanceof PreflightFailedError);
      assert.equal((err as LetmepostError).code, "preflight_failed");
      assert.equal((err as LetmepostError).rule, "bluesky.text.max_graphemes");
      assert.equal((err as LetmepostError).requestId, "req_test_2");
      assert.equal((err as LetmepostError).status, 400);
      return true;
    },
  );
});

test("401 with envelope becomes UnauthenticatedError", async () => {
  const rec: Recorder = {
    calls: [],
    responses: [
      () =>
        jsonResponse(
          { error: { code: "unauthenticated", message: "no key" } },
          401,
        ),
    ],
  };
  const lmp = new Letmepost({
    apiKey: "lmp_test_abc",
    fetch: mockFetch(rec),
    retries: 0,
  });
  await assert.rejects(
    () => lmp.posts.list(),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("429 retries up to budget then throws RateLimitedError", async () => {
  const rec: Recorder = {
    calls: [],
    responses: [
      () =>
        jsonResponse(
          { error: { code: "rate_limited", message: "slow down" } },
          429,
          { "retry-after": "0" },
        ),
      () =>
        jsonResponse(
          { error: { code: "rate_limited", message: "still slow" } },
          429,
          { "retry-after": "0" },
        ),
    ],
  };
  const lmp = new Letmepost({
    apiKey: "lmp_test_abc",
    fetch: mockFetch(rec),
    retries: 1,
    retryBaseMs: 1,
  });
  await assert.rejects(
    () => lmp.posts.list(),
    (err: unknown) => {
      assert.ok(err instanceof RateLimitedError);
      return true;
    },
  );
  assert.equal(rec.calls.length, 2);
});

test("verifyWebhook accepts valid sha256= signature and returns parsed JSON", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "post.published", data: {} });
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const event = verifyWebhook<{ id: string }>({ body, signature: sig, secret });
  assert.equal(event.id, "evt_1");
});

test("verifyWebhookSignature rejects tampered bodies", () => {
  const secret = "whsec_test";
  const sig = `sha256=${createHmac("sha256", secret).update("a").digest("hex")}`;
  assert.equal(
    verifyWebhookSignature({ body: "b", signature: sig, secret }),
    false,
  );
});

test("verifyWebhookSignature accepts bare-hex signatures (proxy-stripped prefix)", () => {
  const secret = "whsec_test";
  const body = "ok";
  const bare = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyWebhookSignature({ body, signature: bare, secret }), true);
});

test("verifyWebhookSignature accepts Uint8Array bodies", () => {
  const secret = "whsec_test";
  const body = Buffer.from("hello", "utf8");
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(
    verifyWebhookSignature({ body: new Uint8Array(body), signature: sig, secret }),
    true,
  );
});
