import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
import { seed } from "../src/db/seed.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

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
});
