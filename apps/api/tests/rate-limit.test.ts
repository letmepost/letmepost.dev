import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
import { seed } from "../src/db/seed.js";
import { __resetRateLimitForTests } from "../src/middleware/rate-limit.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

const server = setupServer();

beforeEach(() => {
  __resetRateLimitForTests();
  process.env.RATE_LIMIT_POINTS = "3";
  process.env.RATE_LIMIT_DURATION_SEC = "60";
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  delete process.env.RATE_LIMIT_POINTS;
  delete process.env.RATE_LIMIT_DURATION_SEC;
  __resetRateLimitForTests();
});

afterAll(async () => {
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

function blueskyHappyHandlers(did = "did:plc:test") {
  return [
    http.post(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      () =>
        HttpResponse.json({
          accessJwt: "access",
          refreshJwt: "refresh",
          did,
          handle: "alice.bsky.social",
        }),
    ),
    http.post(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      () =>
        HttpResponse.json({
          uri: `at://${did}/app.bsky.feed.post/abcxyz`,
          cid: "bafy-mock",
        }),
    ),
  ];
}

describeIfDb("rate limit middleware on POST /v1/posts", () => {
  it("emits RateLimit-* headers on successful responses", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(...blueskyHappyHandlers());

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "hello",
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("ratelimit-limit")).toBe("3");
      expect(res.headers.get("ratelimit-remaining")).toBe("2");
      expect(res.headers.get("ratelimit-reset")).toBeTruthy();
    });
  });

  it("returns 429 rate_limited with Retry-After once the budget is spent", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(...blueskyHappyHandlers());

      const app = createApp({ db: tx });
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fixture.apiKey.plaintext}`,
      };
      const body = JSON.stringify({
        targets: [{ accountId: fixture.accountId }],
        text: "hello",
      });

      for (let i = 0; i < 3; i += 1) {
        const ok = await app.request("/v1/posts", { method: "POST", headers, body });
        expect(ok.status).toBe(200);
      }

      const blocked = await app.request("/v1/posts", { method: "POST", headers, body });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
      const payload = (await blocked.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("rate_limited");
    });
  });

  it("scopes the bucket per api key — another org's key isn't affected", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixtureA = await seed(tx);
      const fixtureB = await seed(tx);
      server.use(...blueskyHappyHandlers());

      const app = createApp({ db: tx });
      const bodyA = JSON.stringify({
        targets: [{ accountId: fixtureA.accountId }],
        text: "A",
      });
      const bodyB = JSON.stringify({
        targets: [{ accountId: fixtureB.accountId }],
        text: "B",
      });

      // Burn org A's quota.
      for (let i = 0; i < 3; i += 1) {
        const ok = await app.request("/v1/posts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixtureA.apiKey.plaintext}`,
          },
          body: bodyA,
        });
        expect(ok.status).toBe(200);
      }
      const blockedA = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixtureA.apiKey.plaintext}`,
        },
        body: bodyA,
      });
      expect(blockedA.status).toBe(429);

      // Org B still has full budget.
      const okB = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixtureB.apiKey.plaintext}`,
        },
        body: bodyB,
      });
      expect(okB.status).toBe(200);
      expect(okB.headers.get("ratelimit-remaining")).toBe("2");
    });
  });
});
