import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
import { seed } from "../src/db/seed.js";
import { idempotencyRecords } from "../src/db/schema/idempotency_records.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import { idempotency } from "../src/middleware/idempotency.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

function hashBody(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

function countingBlueskyHandlers(did = "did:plc:test") {
  const calls = { createSession: 0, createRecord: 0 };
  const handlers = [
    http.post(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      () => {
        calls.createSession += 1;
        return HttpResponse.json({
          accessJwt: "access",
          refreshJwt: "refresh",
          did,
          handle: "alice.bsky.social",
        });
      },
    ),
    http.post(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      () => {
        calls.createRecord += 1;
        return HttpResponse.json({
          uri: `at://${did}/app.bsky.feed.post/abcxyz`,
          cid: "bafy-mock",
        });
      },
    ),
  ];
  return { handlers, calls };
}

describeIfDb("Idempotency-Key middleware on POST /v1/posts", () => {
  it("passes requests through unchanged when no Idempotency-Key is sent", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { handlers, calls } = countingBlueskyHandlers();
      server.use(...handlers);

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "no idempotency key",
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("idempotency-replayed")).toBeNull();
      expect(calls.createRecord).toBe(1);
    });
  });

  it("replays the stored response on second call with same key + body", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { handlers, calls } = countingBlueskyHandlers();
      server.use(...handlers);

      const app = createApp({ db: tx });
      const body = JSON.stringify({
        targets: [{ accountId: fixture.accountId }],
        text: "same body every time",
      });
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        "Idempotency-Key": "idem_replay_probe",
      };

      const first = await app.request("/v1/posts", { method: "POST", headers, body });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(calls.createRecord).toBe(1);

      const second = await app.request("/v1/posts", { method: "POST", headers, body });
      expect(second.status).toBe(200);
      expect(second.headers.get("idempotency-replayed")).toBe("true");
      expect(second.headers.get("idempotency-key")).toBe("idem_replay_probe");
      const secondBody = await second.json();
      expect(secondBody).toEqual(firstBody);
      // Upstream only contacted for the first request.
      expect(calls.createRecord).toBe(1);
    });
  });

  it("returns 409 idempotency_conflict when the same key is reused with a different body", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { handlers, calls } = countingBlueskyHandlers();
      server.use(...handlers);

      const app = createApp({ db: tx });
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        "Idempotency-Key": "idem_conflict_probe",
      };

      const first = await app.request("/v1/posts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "original text",
        }),
      });
      expect(first.status).toBe(200);

      const second = await app.request("/v1/posts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "different text, same key",
        }),
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("idempotency_conflict");
      expect(body.error.rule).toBe("idempotency_key.body_mismatch");
      // Upstream only contacted for the first request.
      expect(calls.createRecord).toBe(1);
    });
  });

  it("scopes keys per organization — the same key in a different org is a fresh request", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixtureA = await seed(tx);
      const fixtureB = await seed(tx);
      const { handlers, calls } = countingBlueskyHandlers();
      server.use(...handlers);

      const app = createApp({ db: tx });
      const sharedKey = "idem_shared_across_orgs";

      const a = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixtureA.apiKey.plaintext}`,
          "Idempotency-Key": sharedKey,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixtureA.accountId }],
          text: "org A",
        }),
      });
      expect(a.status).toBe(200);

      const b = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixtureB.apiKey.plaintext}`,
          "Idempotency-Key": sharedKey,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixtureB.accountId }],
          text: "org B",
        }),
      });
      expect(b.status).toBe(200);
      expect(b.headers.get("idempotency-replayed")).toBeNull();
      // Both requests hit upstream — neither is a replay.
      expect(calls.createRecord).toBe(2);
    });
  });

  it("replays 4xx responses too (preflight failures are stable)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { handlers, calls } = countingBlueskyHandlers();
      server.use(...handlers);

      const app = createApp({ db: tx });
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        "Idempotency-Key": "idem_4xx_probe",
      };
      const body = JSON.stringify({
        targets: [{ accountId: fixture.accountId }],
        text: "   ",
      });

      const first = await app.request("/v1/posts", { method: "POST", headers, body });
      expect(first.status).toBe(400);
      const firstBody = await first.json();

      const second = await app.request("/v1/posts", { method: "POST", headers, body });
      expect(second.status).toBe(400);
      expect(second.headers.get("idempotency-replayed")).toBe("true");
      const secondBody = await second.json();
      expect(secondBody).toEqual(firstBody);
      expect(calls.createRecord).toBe(0);
    });
  });

  it("returns 409 in_progress (and does NOT run the handler) when a pending claim exists", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { handlers, calls } = countingBlueskyHandlers();
      server.use(...handlers);

      const key = "idem_in_progress_probe";
      const body = JSON.stringify({
        targets: [{ accountId: fixture.accountId }],
        text: "concurrent request",
      });

      // Simulate another request currently executing this exact key: an
      // in-flight sentinel row (statusCode 0) created just now (not stale).
      await tx.insert(idempotencyRecords).values({
        organizationId: fixture.organizationId,
        key,
        requestHash: hashBody(body),
        responseBody: null,
        statusCode: 0,
        createdAt: new Date(),
      });

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          "Idempotency-Key": key,
        },
        body,
      });

      expect(res.status).toBe(409);
      const parsed = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(parsed.error.code).toBe("idempotency_conflict");
      expect(parsed.error.rule).toBe("idempotency_key.in_progress");

      // The handler must not have run: no upstream call, no post row created.
      expect(calls.createRecord).toBe(0);
      const rows = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.organizationId, fixture.organizationId));
      expect(rows).toHaveLength(0);
    });
  });

  it("takes over a stale pending claim and re-executes the handler", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { handlers, calls } = countingBlueskyHandlers();
      server.use(...handlers);

      const key = "idem_stale_takeover_probe";
      const body = JSON.stringify({
        targets: [{ accountId: fixture.accountId }],
        text: "abandoned then retried",
      });

      // A pending row left behind by a crashed request, older than PENDING_TTL.
      await tx.insert(idempotencyRecords).values({
        organizationId: fixture.organizationId,
        key,
        requestHash: "stale-placeholder-hash",
        responseBody: null,
        statusCode: 0,
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      });

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          "Idempotency-Key": key,
        },
        body,
      });

      // The stale claim was taken over: the handler ran and published.
      expect(res.status).toBe(200);
      expect(res.headers.get("idempotency-replayed")).toBeNull();
      expect(calls.createRecord).toBe(1);

      // The row is now completed (real status stored, requestHash refreshed).
      const [record] = await tx
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.organizationId, fixture.organizationId),
            eq(idempotencyRecords.key, key),
          ),
        );
      expect(record?.statusCode).toBe(200);
      expect(record?.requestHash).toBe(hashBody(body));
      expect(record?.responseBody).not.toBeNull();
    });
  });

  it("does not store a record for a 5xx response, so a retry can execute", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);

      // Minimal app: idempotency middleware in front of a handler that fails
      // with 5xx on the first call and succeeds on the second. Exercises the
      // 5xx-release path directly, since POST /v1/posts wraps per-target
      // failures in a 200 batch envelope and rarely surfaces a raw 5xx.
      let calls = 0;
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("db", tx);
        c.set("apiKey", {
          organizationId: fixture.organizationId,
          apiKeyId: "test",
          scopes: ["posts:write"],
          profileId: null,
        });
        await next();
      });
      app.post("/probe", idempotency(), (c) =>
        ++calls === 1
          ? c.json({ error: "boom" }, 503)
          : c.json({ ok: true }, 200),
      );

      const key = "idem_5xx_probe";
      const headers = {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      };
      const body = JSON.stringify({ hello: "world" });

      const first = await app.request("/probe", { method: "POST", headers, body });
      expect(first.status).toBe(503);

      // The 5xx released the claim — no record persisted.
      const afterFirst = await tx
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.organizationId, fixture.organizationId),
            eq(idempotencyRecords.key, key),
          ),
        );
      expect(afterFirst).toHaveLength(0);

      // A retry with the same key executes (not replayed, not 409).
      const second = await app.request("/probe", { method: "POST", headers, body });
      expect(second.status).toBe(200);
      expect(second.headers.get("idempotency-replayed")).toBeNull();
      expect(calls).toBe(2);
    });
  });
});
