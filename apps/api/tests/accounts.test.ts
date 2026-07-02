import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
import { apiKeys } from "../src/db/schema/api_keys.js";
import { member, organization, user } from "../src/db/schema/auth.js";
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

async function seedOrg(tx: Awaited<ReturnType<typeof getTestDb>>["db"]) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [u] = await tx
    .insert(user)
    .values({
      email: `acct+${suffix}@letmepost.test`,
      name: `Acct User ${suffix}`,
      emailVerified: true,
    })
    .returning();
  const [org] = await tx
    .insert(organization)
    .values({ name: `acct-org-${suffix}`, slug: `acct-${suffix}` })
    .returning();
  await tx
    .insert(member)
    .values({ organizationId: org!.id, userId: u!.id, role: "owner" });
  // Mint a real org-scoped API key. The /v1/accounts read routes authenticate
  // through `apiKeyOrSession()`, which is NOT the injected test session —
  // it only honors a Bearer `lmp_…` token or a live better-auth cookie. The
  // testSession short-circuit covers the session-guarded write routes only,
  // so list/detail must present a genuine Bearer key to reach the handlers
  // and actually exercise the cross-org isolation checks.
  const apiKey = `lmp_test_${randomBytes(24).toString("base64url")}`;
  await tx.insert(apiKeys).values({
    organizationId: org!.id,
    name: "acct-test-key",
    prefix: "lmp_test_",
    hashedKey: createHash("sha256").update(apiKey).digest("hex"),
    last4: apiKey.slice(-4),
    scopes: ["posts:read", "posts:write"],
  });
  return { userId: u!.id, organizationId: org!.id, apiKey };
}

// Minimal JWT with an `exp` claim 2h out so decodeJwtExp has something to read.
function buildMockAccessJwt(expSecondsFromNow = 2 * 60 * 60): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describeIfDb("/v1/accounts (connect + CRUD)", () => {
  it("POST /connect/:platform returns a Bluesky credentials descriptor", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { userId, organizationId } = await seedOrg(tx);
      const app = createApp({
        db: tx,
        testSession: { userId, organizationId },
        refreshEnqueuer: { async enqueue() {} },
      });

      const res = await app.request("/v1/accounts/connect/bluesky", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        platform: string;
        descriptor: {
          kind: string;
          fields: { name: string; required: boolean }[];
          helpText?: string;
        };
      };
      expect(body.platform).toBe("bluesky");
      expect(body.descriptor.kind).toBe("credentials");
      const names = body.descriptor.fields.map((f) => f.name).sort();
      expect(names).toEqual(["appPassword", "identifier", "pdsUrl"]);
      expect(body.descriptor.helpText).toMatch(/app password/i);
    });
  });

  it("POST /connect/:platform rejects unknown platforms", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { userId, organizationId } = await seedOrg(tx);
      const app = createApp({
        db: tx,
        testSession: { userId, organizationId },
        refreshEnqueuer: { async enqueue() {} },
      });

      const res = await app.request("/v1/accounts/connect/myspace", {
        method: "POST",
      });
      expect(res.status).toBe(400);
    });
  });

  it("POST /connect/bluesky/complete creates the account and never returns secrets", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { userId, organizationId } = await seedOrg(tx);
      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json({
              accessJwt: buildMockAccessJwt(),
              refreshJwt: "refresh-token-xyz",
              did: "did:plc:alice",
              handle: "alice.bsky.social",
            }),
        ),
      );
      const app = createApp({
        db: tx,
        testSession: { userId, organizationId },
        refreshEnqueuer: { async enqueue() {} },
      });

      const res = await app.request("/v1/accounts/connect/bluesky/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "alice.bsky.social",
          appPassword: "abcd-efgh-ijkl-mnop",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        platform: string;
        platformAccountId: string;
        displayName: string;
        tokenExpiresAt: string | null;
      };
      expect(body.platform).toBe("bluesky");
      expect(body.platformAccountId).toBe("did:plc:alice");
      expect(body.displayName).toBe("alice.bsky.social");
      expect(body.tokenExpiresAt).toBeTruthy();

      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/abcd-efgh-ijkl-mnop/);
      expect(serialized).not.toMatch(/refresh-token-xyz/);
      expect(serialized).not.toMatch(/"token"/);
    });
  });

  it("POST /connect/bluesky/complete surfaces upstream auth failure as platform_auth_failed", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { userId, organizationId } = await seedOrg(tx);
      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json(
              { error: "AuthenticationRequired", message: "Invalid identifier or password" },
              { status: 401 },
            ),
        ),
      );
      const app = createApp({
        db: tx,
        testSession: { userId, organizationId },
        refreshEnqueuer: { async enqueue() {} },
      });

      const res = await app.request("/v1/accounts/connect/bluesky/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "nope.bsky.social",
          appPassword: "wrong-wrong-wrong-xxxx",
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("platform_auth_failed");
    });
  });

  it("POST /connect/bluesky/complete upserts on reconnect (rotates token, no duplicate row)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { userId, organizationId, apiKey } = await seedOrg(tx);
      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json({
              accessJwt: buildMockAccessJwt(),
              refreshJwt: "refresh-token-xyz",
              did: "did:plc:alice",
              handle: "alice.bsky.social",
            }),
        ),
      );
      const app = createApp({
        db: tx,
        testSession: { userId, organizationId },
        refreshEnqueuer: { async enqueue() {} },
      });

      const first = await app.request("/v1/accounts/connect/bluesky/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "alice.bsky.social",
          appPassword: "abcd-efgh-ijkl-mnop",
        }),
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { id: string };

      const second = await app.request("/v1/accounts/connect/bluesky/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "alice.bsky.social",
          appPassword: "zzzz-yyyy-xxxx-wwww",
        }),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { id: string };
      expect(secondBody.id).toBe(firstBody.id);

      const list = await app.request("/v1/accounts", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const listBody = (await list.json()) as { data: unknown[] };
      expect(listBody.data).toHaveLength(1);
    });
  });

  it("GET /v1/accounts lists only the session org's accounts", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const orgA = await seedOrg(tx);
      const orgB = await seedOrg(tx);

      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          ({ request }) => {
            return request.text().then((raw) => {
              const parsed = JSON.parse(raw) as { identifier: string };
              return HttpResponse.json({
                accessJwt: buildMockAccessJwt(),
                refreshJwt: "r",
                did: `did:plc:${parsed.identifier.replace(/\W/g, "")}`,
                handle: parsed.identifier,
              });
            });
          },
        ),
      );
      const appA = createApp({
        db: tx,
        testSession: orgA,
        refreshEnqueuer: { async enqueue() {} },
      });
      const appB = createApp({
        db: tx,
        testSession: orgB,
        refreshEnqueuer: { async enqueue() {} },
      });

      await appA.request("/v1/accounts/connect/bluesky/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "alice.bsky.social",
          appPassword: "abcd-efgh-ijkl-mnop",
        }),
      });
      await appB.request("/v1/accounts/connect/bluesky/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "bob.bsky.social",
          appPassword: "qqqq-wwww-eeee-rrrr",
        }),
      });

      const listA = await appA.request("/v1/accounts", {
        headers: { Authorization: `Bearer ${orgA.apiKey}` },
      });
      const listB = await appB.request("/v1/accounts", {
        headers: { Authorization: `Bearer ${orgB.apiKey}` },
      });
      const bodyA = (await listA.json()) as { data: { displayName: string }[] };
      const bodyB = (await listB.json()) as { data: { displayName: string }[] };
      expect(bodyA.data.map((r) => r.displayName)).toEqual(["alice.bsky.social"]);
      expect(bodyB.data.map((r) => r.displayName)).toEqual(["bob.bsky.social"]);
    });
  });

  it("GET /:id from another org returns 404", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const orgA = await seedOrg(tx);
      const orgB = await seedOrg(tx);

      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json({
              accessJwt: buildMockAccessJwt(),
              refreshJwt: "r",
              did: "did:plc:alice",
              handle: "alice.bsky.social",
            }),
        ),
      );
      const appA = createApp({
        db: tx,
        testSession: orgA,
        refreshEnqueuer: { async enqueue() {} },
      });
      const appB = createApp({
        db: tx,
        testSession: orgB,
        refreshEnqueuer: { async enqueue() {} },
      });

      const created = await appA.request(
        "/v1/accounts/connect/bluesky/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: "alice.bsky.social",
            appPassword: "abcd-efgh-ijkl-mnop",
          }),
        },
      );
      const { id } = (await created.json()) as { id: string };

      const crossOrg = await appB.request(`/v1/accounts/${id}`, {
        headers: { Authorization: `Bearer ${orgB.apiKey}` },
      });
      expect(crossOrg.status).toBe(404);
    });
  });

  it("DELETE /:id hard-deletes; subsequent GET returns 404", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { userId, organizationId, apiKey } = await seedOrg(tx);
      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json({
              accessJwt: buildMockAccessJwt(),
              refreshJwt: "r",
              did: "did:plc:alice",
              handle: "alice.bsky.social",
            }),
        ),
      );
      const app = createApp({
        db: tx,
        testSession: { userId, organizationId },
        refreshEnqueuer: { async enqueue() {} },
      });

      const created = await app.request(
        "/v1/accounts/connect/bluesky/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: "alice.bsky.social",
            appPassword: "abcd-efgh-ijkl-mnop",
          }),
        },
      );
      const { id } = (await created.json()) as { id: string };

      const del = await app.request(`/v1/accounts/${id}`, { method: "DELETE" });
      expect(del.status).toBe(200);

      const after = await app.request(`/v1/accounts/${id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(after.status).toBe(404);
    });
  });

  it("DELETE /:id from another org returns 404 and leaves the record intact", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const orgA = await seedOrg(tx);
      const orgB = await seedOrg(tx);

      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json({
              accessJwt: buildMockAccessJwt(),
              refreshJwt: "r",
              did: "did:plc:alice",
              handle: "alice.bsky.social",
            }),
        ),
      );
      const appA = createApp({
        db: tx,
        testSession: orgA,
        refreshEnqueuer: { async enqueue() {} },
      });
      const appB = createApp({
        db: tx,
        testSession: orgB,
        refreshEnqueuer: { async enqueue() {} },
      });

      const created = await appA.request(
        "/v1/accounts/connect/bluesky/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: "alice.bsky.social",
            appPassword: "abcd-efgh-ijkl-mnop",
          }),
        },
      );
      const { id } = (await created.json()) as { id: string };

      const crossOrg = await appB.request(`/v1/accounts/${id}`, {
        method: "DELETE",
      });
      expect(crossOrg.status).toBe(404);

      const stillThere = await appA.request(`/v1/accounts/${id}`, {
        headers: { Authorization: `Bearer ${orgA.apiKey}` },
      });
      expect(stillThere.status).toBe(200);
    });
  });
});
