import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import { seed } from "../src/db/seed.js";
import { decodeCursor } from "../src/repositories/posts.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";
import type { DrizzleClient } from "../src/db/index.js";

const describeIfDb = canRunDbTests ? describe : describe.skip;

/**
 * Insert N posts in chronological order with a configurable status / error
 * shape per index. Returns the inserted rows so tests can assert against
 * specific ids.
 */
async function seedPosts(
  tx: DrizzleClient,
  args: {
    organizationId: string;
    accountId: string;
    count: number;
    template: (i: number) => Partial<typeof postsTable.$inferInsert>;
  },
) {
  const inserted: { id: string; createdAt: Date }[] = [];
  for (let i = 0; i < args.count; i++) {
    const overrides = args.template(i);
    const [row] = await tx
      .insert(postsTable)
      .values({
        organizationId: args.organizationId,
        accountId: args.accountId,
        text: `post ${i}`,
        status: "published",
        ...overrides,
      })
      .returning();
    if (!row) throw new Error("failed to seed post");
    inserted.push({ id: row.id, createdAt: row.createdAt });
    // Postgres timestamps default to now() with sub-millisecond precision,
    // but tests run fast — sleep to keep the (createdAt, id) tuple monotonic.
    await new Promise((r) => setTimeout(r, 2));
  }
  return inserted;
}

describeIfDb("GET /v1/posts (Post Log list)", () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it("returns posts for the API key's org, newest first", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await seedPosts(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        count: 3,
        template: () => ({}),
      });

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { id: string; text: string; account: { platform: string } }[];
        nextCursor: string | null;
      };
      expect(body.data).toHaveLength(3);
      expect(body.data[0]!.text).toBe("post 2"); // newest first
      expect(body.data[2]!.text).toBe("post 0");
      expect(body.data[0]!.account.platform).toBe("bluesky");
      expect(body.nextCursor).toBeNull();
    });
  });

  it("filters by status (?status=failed) and excludes other states", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await seedPosts(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        count: 4,
        template: (i) => ({
          status: i < 2 ? "failed" : "published",
          ...(i < 2
            ? { error: { code: "platform_unavailable", message: "down" } }
            : {}),
        }),
      });

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts?status=failed", {
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { status: string }[] };
      expect(body.data).toHaveLength(2);
      expect(body.data.every((p) => p.status === "failed")).toBe(true);
    });
  });

  it("filters by errorCode using JSON `error->>code` lookup", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await seedPosts(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        count: 3,
        template: (i) => ({
          status: "rejected",
          error: {
            code: i === 0 ? "preflight_failed" : "platform_rejected",
          },
        }),
      });

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts?errorCode=preflight_failed", {
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { error: { code: string } }[];
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.error.code).toBe("preflight_failed");
    });
  });

  it("filters by free-text ?q (case-insensitive substring on body)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await seedPosts(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        count: 3,
        template: (i) => ({
          text:
            i === 0
              ? "Launch day is finally here"
              : i === 1
                ? "Behind the LAUNCH"
                : "Weekly roundup",
        }),
      });

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts?q=launch", {
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { text: string }[] };
      expect(body.data).toHaveLength(2);
      expect(
        body.data.every((p) => p.text.toLowerCase().includes("launch")),
      ).toBe(true);
    });
  });

  it("treats LIKE wildcards in ?q literally (no `%` expansion)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await seedPosts(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        count: 2,
        template: (i) => ({ text: i === 0 ? "50% off today" : "plain text" }),
      });

      const app = createApp({ db: tx });
      const res = await app.request(`/v1/posts?q=${encodeURIComponent("50%")}`, {
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { text: string }[] };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.text).toBe("50% off today");
    });
  });

  it("paginates via opaque cursor; cursor decodes to a valid (createdAt, id)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await seedPosts(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        count: 5,
        template: () => ({}),
      });

      const app = createApp({ db: tx });
      const first = await app.request("/v1/posts?limit=2", {
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      const firstBody = (await first.json()) as {
        data: { id: string }[];
        nextCursor: string | null;
      };
      expect(firstBody.data).toHaveLength(2);
      expect(firstBody.nextCursor).not.toBeNull();
      expect(decodeCursor(firstBody.nextCursor!)).not.toBeNull();

      const second = await app.request(
        `/v1/posts?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
        { headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` } },
      );
      const secondBody = (await second.json()) as {
        data: { id: string }[];
        nextCursor: string | null;
      };
      expect(secondBody.data).toHaveLength(2);
      const seen = new Set([
        ...firstBody.data.map((d) => d.id),
        ...secondBody.data.map((d) => d.id),
      ]);
      expect(seen.size).toBe(4); // no duplicates across pages
    });
  });

  it("does not leak posts from other orgs", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const orgA = await seed(tx);
      const orgB = await seed(tx);
      await seedPosts(tx, {
        organizationId: orgA.organizationId,
        accountId: orgA.accountId,
        count: 2,
        template: () => ({ text: "A's post" }),
      });
      await seedPosts(tx, {
        organizationId: orgB.organizationId,
        accountId: orgB.accountId,
        count: 2,
        template: () => ({ text: "B's post" }),
      });

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        headers: { Authorization: `Bearer ${orgA.apiKey.plaintext}` },
      });
      const body = (await res.json()) as { data: { text: string }[] };
      expect(body.data).toHaveLength(2);
      expect(body.data.every((p) => p.text === "A's post")).toBe(true);
    });
  });

  it("rejects malformed cursors with the rest of the page intact (graceful)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await seedPosts(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        count: 2,
        template: () => ({}),
      });

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts?cursor=this-is-not-a-cursor", {
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      // Bad cursor falls back to "no cursor" — strictly, we could 400 instead.
      // Soft-fallback is the friendlier choice for a Log surface.
      expect(res.status).toBe(200);
    });
  });
});

describeIfDb("GET /v1/posts/:id (Post Log detail)", () => {
  it("returns the full record + empty attempts array (until attempts are recorded)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const [post] = await seedPosts(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        count: 1,
        template: () => ({
          status: "rejected",
          error: {
            code: "preflight_failed",
            rule: "bluesky.text.max_graphemes",
            message: "Post text is 312 graphemes; Bluesky allows at most 300.",
            remediation: "Shorten the post.",
          },
        }),
      });

      const app = createApp({ db: tx });
      const res = await app.request(`/v1/posts/${post!.id}`, {
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        status: string;
        error: { code: string; rule?: string };
        account: { platform: string };
        attempts: unknown[];
      };
      expect(body.id).toBe(post!.id);
      expect(body.status).toBe("rejected");
      expect(body.error.code).toBe("preflight_failed");
      expect(body.error.rule).toBe("bluesky.text.max_graphemes");
      expect(body.account.platform).toBe("bluesky");
      expect(body.attempts).toEqual([]);
    });
  });

  it("returns 404 for a post in a different org (no existence leak)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const orgA = await seed(tx);
      const orgB = await seed(tx);
      const [postA] = await seedPosts(tx, {
        organizationId: orgA.organizationId,
        accountId: orgA.accountId,
        count: 1,
        template: () => ({}),
      });

      const app = createApp({ db: tx });
      const res = await app.request(`/v1/posts/${postA!.id}`, {
        headers: { Authorization: `Bearer ${orgB.apiKey.plaintext}` },
      });
      expect(res.status).toBe(404);
    });
  });

  it("returns 404 for unknown ids", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const app = createApp({ db: tx });
      // valid uuid but not present
      const res = await app.request(
        "/v1/posts/00000000-0000-0000-0000-000000000000",
        { headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` } },
      );
      expect(res.status).toBe(404);
    });
  });
});

describeIfDb("Post Log + API-key profile scope", () => {
  /**
   * Profile-scope helper — same shape as posts-profile-scope.test.ts but
   * inlined for clarity. Mints a profile-scoped key + a post in that
   * profile, plus an unrelated profile/post in the same org.
   */
  async function setupTwoProfilesOneOrg(
    tx: DrizzleClient,
  ): Promise<{
    fixture: Awaited<ReturnType<typeof seed>>;
    profileAKeyPlaintext: string;
    postInA: { id: string };
    postInB: { id: string };
  }> {
    const { createHash, randomBytes } = await import("node:crypto");
    const { apiKeys } = await import("../src/db/schema/api_keys.js");
    const { DrizzlePlatformAccountsRepository } = await import(
      "../src/repositories/platform-accounts.js"
    );
    const { DrizzleProfilesRepository } = await import(
      "../src/repositories/profiles.js"
    );

    const fixture = await seed(tx);
    const profileRepo = new DrizzleProfilesRepository(tx);
    const accountRepo = new DrizzlePlatformAccountsRepository(tx);

    const profileA = await profileRepo.create({
      organizationId: fixture.organizationId,
      name: "client-a",
      slug: "client-a",
    });
    const profileB = await profileRepo.create({
      organizationId: fixture.organizationId,
      name: "client-b",
      slug: "client-b",
    });
    const accountA = await accountRepo.create({
      organizationId: fixture.organizationId,
      profileId: profileA.id,
      platform: "bluesky",
      platformAccountId: "did:plc:scoped-A",
      token: "t-a",
    });
    const accountB = await accountRepo.create({
      organizationId: fixture.organizationId,
      profileId: profileB.id,
      platform: "bluesky",
      platformAccountId: "did:plc:scoped-B",
      token: "t-b",
    });

    const [postInA] = await tx
      .insert(postsTable)
      .values({
        organizationId: fixture.organizationId,
        accountId: accountA.id,
        text: "A post",
        status: "published",
      })
      .returning();
    const [postInB] = await tx
      .insert(postsTable)
      .values({
        organizationId: fixture.organizationId,
        accountId: accountB.id,
        text: "B post",
        status: "published",
      })
      .returning();

    const rawSecret = randomBytes(24).toString("base64url");
    const plaintext = `lmp_test_${rawSecret}`;
    await tx.insert(apiKeys).values({
      organizationId: fixture.organizationId,
      profileId: profileA.id,
      name: "scoped-A",
      prefix: "lmp_test_",
      hashedKey: createHash("sha256").update(plaintext).digest("hex"),
      last4: plaintext.slice(-4),
      scopes: ["posts:read"],
    });

    return {
      fixture,
      profileAKeyPlaintext: plaintext,
      postInA: { id: postInA!.id },
      postInB: { id: postInB!.id },
    };
  }

  it("profile-scoped key only sees its profile's posts on list", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { profileAKeyPlaintext, postInA, postInB } =
        await setupTwoProfilesOneOrg(tx);
      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        headers: { Authorization: `Bearer ${profileAKeyPlaintext}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      const ids = body.data.map((p) => p.id);
      expect(ids).toContain(postInA.id);
      expect(ids).not.toContain(postInB.id);
    });
  });

  it("profile-scoped key 404s on a post in a different profile (detail)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { profileAKeyPlaintext, postInB } =
        await setupTwoProfilesOneOrg(tx);
      const app = createApp({ db: tx });
      const res = await app.request(`/v1/posts/${postInB.id}`, {
        headers: { Authorization: `Bearer ${profileAKeyPlaintext}` },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("api_key.profile_scope");
    });
  });

  it("profile-scoped key 404s when query passes a different profileId", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, profileAKeyPlaintext } = await setupTwoProfilesOneOrg(tx);
      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/posts?profileId=${fixture.profileId}`, // the seed's Default profile, NOT the key's
        { headers: { Authorization: `Bearer ${profileAKeyPlaintext}` } },
      );
      expect(res.status).toBe(404);
    });
  });
});

/* import-only — avoids unused `eq` warning when the test file is open in an
   editor that lints unused imports. eq is imported transitively for clarity
   if the file is extended. */
void eq;
