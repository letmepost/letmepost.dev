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
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { apiKeys } from "../src/db/schema/api_keys.js";
import { member, organization, user } from "../src/db/schema/auth.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import { DrizzleProfilesRepository } from "../src/repositories/profiles.js";
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
  // Read routes authenticate via apiKeyOrSession(), which ignores the injected
  // testSession — list/detail must present a real Bearer key to reach handlers.
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

  it("DELETE /:id preserves post history (account_id nulled) and cancels queued posts", async () => {
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
      const { id: accountId } = (await created.json()) as { id: string };

      // A published post (terminal — this is the history we must preserve) and
      // a queued post (non-terminal — un-publishable once the account is gone).
      const [published] = await tx
        .insert(postsTable)
        .values({
          organizationId,
          accountId,
          text: "shipped it",
          status: "published",
          platformUri: "at://did:plc:alice/app.bsky.feed.post/xyz",
          platformCid: "bafycid",
          publishedAt: new Date(),
        })
        .returning();
      const [queued] = await tx
        .insert(postsTable)
        .values({
          organizationId,
          accountId,
          text: "scheduled for later",
          status: "queued",
          scheduledAt: new Date(Date.now() + 60_000),
        })
        .returning();

      const del = await app.request(`/v1/accounts/${accountId}`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);

      // (a) Published history SURVIVES the cascade, with account_id nulled and
      // every platform/status field intact.
      const [pubAfter] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, published!.id));
      expect(pubAfter).toBeDefined();
      expect(pubAfter!.accountId).toBeNull();
      expect(pubAfter!.status).toBe("published");
      expect(pubAfter!.platformUri).toBe(
        "at://did:plc:alice/app.bsky.feed.post/xyz",
      );
      expect(pubAfter!.platformCid).toBe("bafycid");
      expect(pubAfter!.publishedAt).not.toBeNull();

      // (b) Queued post is CANCELED (not left dangling, not cascade-deleted).
      const [queuedAfter] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, queued!.id));
      expect(queuedAfter).toBeDefined();
      expect(queuedAfter!.status).toBe("canceled");
      expect(queuedAfter!.accountId).toBeNull();

      // GET /v1/posts still serializes the historical post (account fields null).
      const list = await app.request("/v1/posts", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        data: {
          id: string;
          accountId: string | null;
          platform: string | null;
          account: { id: string | null; platform: string | null };
        }[];
      };
      const pubRow = body.data.find((p) => p.id === published!.id);
      expect(pubRow).toBeDefined();
      expect(pubRow!.accountId).toBeNull();
      expect(pubRow!.platform).toBeNull();
      expect(pubRow!.account.id).toBeNull();
      expect(pubRow!.account.platform).toBeNull();

      // GET /v1/posts/:id (detail) also serializes without crashing.
      const detail = await app.request(`/v1/posts/${published!.id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(detail.status).toBe(200);
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

/**
 * Seed one org with TWO profiles, a Bluesky account in each, plus a key
 * scoped to profile A and an org-wide key. Mirrors the profile-scope harness
 * in posts-profile-scope.test.ts so account reads honor the same contract:
 * a profile-scoped key sees only its own profile; org-wide keys see all.
 */
async function seedTwoProfiles(
  tx: Awaited<ReturnType<typeof getTestDb>>["db"],
) {
  const suffix = randomBytes(4).toString("hex");
  const [org] = await tx
    .insert(organization)
    .values({ name: `scope-org-${suffix}`, slug: `scope-${suffix}` })
    .returning();
  const organizationId = org!.id;

  const profileRepo = new DrizzleProfilesRepository(tx);
  const profileA = await profileRepo.create({
    organizationId,
    name: "Client A",
    slug: `client-a-${suffix}`,
  });
  const profileB = await profileRepo.create({
    organizationId,
    name: "Client B",
    slug: `client-b-${suffix}`,
  });

  const accountRepo = new DrizzlePlatformAccountsRepository(tx);
  const accountA = await accountRepo.create({
    organizationId,
    profileId: profileA.id,
    platform: "bluesky",
    platformAccountId: `a-${suffix}.bsky.social`,
    displayName: `a-${suffix}.bsky.social`,
    token: "token-a",
  });
  const accountB = await accountRepo.create({
    organizationId,
    profileId: profileB.id,
    platform: "bluesky",
    platformAccountId: `b-${suffix}.bsky.social`,
    displayName: `b-${suffix}.bsky.social`,
    token: "token-b",
  });

  async function mintKey(profileId: string | null): Promise<string> {
    const plaintext = `lmp_test_${randomBytes(24).toString("base64url")}`;
    await tx.insert(apiKeys).values({
      organizationId,
      profileId,
      name: profileId ? "scoped-key" : "org-wide-key",
      prefix: "lmp_test_",
      hashedKey: createHash("sha256").update(plaintext).digest("hex"),
      last4: plaintext.slice(-4),
      scopes: ["posts:read", "posts:write"],
    });
    return plaintext;
  }

  return {
    organizationId,
    profileA,
    profileB,
    accountA,
    accountB,
    scopedKeyA: await mintKey(profileA.id),
    orgWideKey: await mintKey(null),
  };
}

describeIfDb("/v1/accounts profile-scope enforcement", () => {
  it("GET / with a profile-scoped key lists only that profile's account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const s = await seedTwoProfiles(tx);
      const app = createApp({ db: tx });

      const res = await app.request("/v1/accounts", {
        headers: { Authorization: `Bearer ${s.scopedKeyA}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { id: string; profileId: string }[];
      };
      expect(body.data.map((r) => r.id)).toEqual([s.accountA.id]);
      expect(body.data.every((r) => r.profileId === s.profileA.id)).toBe(true);
    });
  });

  it("GET / with a profile-scoped key can't widen scope via ?profileId=<sibling>", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const s = await seedTwoProfiles(tx);
      const app = createApp({ db: tx });

      const res = await app.request(
        `/v1/accounts?profileId=${s.profileB.id}`,
        { headers: { Authorization: `Bearer ${s.scopedKeyA}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      // The key's scope wins over the query param — still only profile A.
      expect(body.data.map((r) => r.id)).toEqual([s.accountA.id]);
    });
  });

  it("GET / with an org-wide key lists both profiles' accounts", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const s = await seedTwoProfiles(tx);
      const app = createApp({ db: tx });

      const res = await app.request("/v1/accounts", {
        headers: { Authorization: `Bearer ${s.orgWideKey}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      expect(body.data.map((r) => r.id).sort()).toEqual(
        [s.accountA.id, s.accountB.id].sort(),
      );
    });
  });

  it("GET /:id with a profile-scoped key reads its own account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const s = await seedTwoProfiles(tx);
      const app = createApp({ db: tx });

      const res = await app.request(`/v1/accounts/${s.accountA.id}`, {
        headers: { Authorization: `Bearer ${s.scopedKeyA}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(s.accountA.id);
    });
  });

  it("GET /:id with a profile-scoped key 404s on a sibling profile's account (no leak)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const s = await seedTwoProfiles(tx);
      const app = createApp({ db: tx });

      const res = await app.request(`/v1/accounts/${s.accountB.id}`, {
        headers: { Authorization: `Bearer ${s.scopedKeyA}` },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("api_key.profile_scope");
    });
  });

  it("GET /:id with an org-wide key reads any profile's account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const s = await seedTwoProfiles(tx);
      const app = createApp({ db: tx });

      const res = await app.request(`/v1/accounts/${s.accountB.id}`, {
        headers: { Authorization: `Bearer ${s.orgWideKey}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(s.accountB.id);
    });
  });
});
