import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  PUBLISHING_STALE_MS,
  QUEUED_ORPHAN_GRACE_MS,
  QUEUED_ORPHAN_MAX_AGE_MS,
  runPublishReconcile,
  type PublishReconcileDeps,
} from "../src/queue/jobs/publish-reconcile.js";
import { seed } from "../src/db/seed.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import type { DrizzleClient } from "../src/db/index.js";
import type { PublishJobData } from "../src/queue/queues.js";
import type { WebhookEvent } from "@letmepost/schemas";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

afterAll(async () => {
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

const MINUTE_MS = 60 * 1000;

type PostStatus = (typeof postsTable.$inferInsert)["status"];

/**
 * Capturing stand-ins for the queue + webhook edges, so the sweep is exercised
 * against a real database without Redis or outbound HTTP.
 */
function makeDeps(
  db: DrizzleClient,
  jobStates: Record<string, string | null> = {},
): PublishReconcileDeps & {
  enqueued: PublishJobData[];
  removed: string[];
  events: WebhookEvent["type"][];
} {
  const enqueued: PublishJobData[] = [];
  const removed: string[] = [];
  const events: WebhookEvent["type"][] = [];
  return {
    db,
    enqueued,
    removed,
    events,
    enqueuer: {
      async enqueue(data) {
        enqueued.push(data);
      },
      async remove(postId) {
        removed.push(postId);
      },
    },
    dispatcher: {
      async dispatch(event) {
        events.push(event.type);
      },
    } as PublishReconcileDeps["dispatcher"],
    async findJobState(postId) {
      return jobStates[postId] ?? null;
    },
  };
}

async function insertPost(
  tx: DrizzleClient,
  values: {
    organizationId: string;
    accountId: string;
    status: PostStatus;
    scheduledAt?: Date | null;
    updatedAt?: Date;
    platformCid?: string | null;
  },
): Promise<string> {
  const [row] = await tx
    .insert(postsTable)
    .values({
      organizationId: values.organizationId,
      accountId: values.accountId,
      status: values.status,
      text: `reconcile-${values.status}`,
      scheduledAt: values.scheduledAt ?? null,
      ...(values.updatedAt ? { updatedAt: values.updatedAt } : {}),
      ...(values.platformCid !== undefined
        ? { platformCid: values.platformCid }
        : {}),
    })
    .returning();
  if (!row) throw new Error("failed to insert post");
  return row.id;
}

describeIfDb("runPublishReconcile — orphaned queued posts", () => {
  it("re-drives a queued post whose publish job never made it to the queue", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const now = new Date("2026-07-05T12:00:00.000Z");
      const base = {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
      };

      // Past due, no job behind it — the exact shape left behind when the
      // row commits and the enqueue then fails.
      const orphan = await insertPost(tx, {
        ...base,
        status: "queued",
        scheduledAt: new Date(now.getTime() - 10 * MINUTE_MS),
      });
      // Past due but a delayed job is still pending — must be left alone.
      const healthy = await insertPost(tx, {
        ...base,
        status: "queued",
        scheduledAt: new Date(now.getTime() - 10 * MINUTE_MS),
      });
      // Not due yet — outside the sweep entirely.
      const future = await insertPost(tx, {
        ...base,
        status: "queued",
        scheduledAt: new Date(now.getTime() + 60 * MINUTE_MS),
      });

      const deps = makeDeps(tx, { [healthy]: "delayed" });
      await runPublishReconcile(deps, { now });

      // Membership, not totals: the sweep is org-wide and the shared test
      // database carries rows from other fixtures.
      const ids = deps.enqueued.map((d) => d.postId);
      expect(ids).toContain(orphan);
      expect(ids).not.toContain(healthy);
      expect(ids).not.toContain(future);
      expect(
        deps.enqueued.find((d) => d.postId === orphan)?.organizationId,
      ).toBe(fixture.organizationId);
    });
  });

  it("clears a lingering completed job first so BullMQ cannot dedupe the re-drive", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const now = new Date("2026-07-05T12:00:00.000Z");
      const orphan = await insertPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        status: "queued",
        scheduledAt: new Date(now.getTime() - 10 * MINUTE_MS),
      });

      const deps = makeDeps(tx, { [orphan]: "completed" });
      await runPublishReconcile(deps, { now });

      expect(deps.removed).toContain(orphan);
      expect(deps.enqueued.map((d) => d.postId)).toContain(orphan);
    });
  });

  it("fails a long-abandoned post instead of firing a stale backlog", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const now = new Date("2026-07-05T12:00:00.000Z");
      // The shape of the production backlog: scheduled a week ago, never
      // enqueued. Re-driving these on deploy would blast out a week of posts
      // at once, which nobody asked for and nobody can take back.
      const ancient = await insertPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        status: "queued",
        scheduledAt: new Date(now.getTime() - 7 * 24 * 60 * MINUTE_MS),
      });

      const deps = makeDeps(tx);
      await runPublishReconcile(deps, { now });

      expect(deps.enqueued.map((d) => d.postId)).not.toContain(ancient);
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, ancient));
      expect(row?.status).toBe("failed");
      expect(row?.error).toMatchObject({ code: "internal_error" });
      expect(deps.events).toContain("post.failed");
    });
  });

  it("still re-drives a post that is late but inside the send window", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const now = new Date("2026-07-05T12:00:00.000Z");
      const recentlyLate = await insertPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        status: "queued",
        scheduledAt: new Date(now.getTime() - QUEUED_ORPHAN_MAX_AGE_MS / 2),
      });

      const deps = makeDeps(tx);
      await runPublishReconcile(deps, { now });

      expect(deps.enqueued.map((d) => d.postId)).toContain(recentlyLate);
    });
  });

  it("leaves a post inside the scheduling grace window alone", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const now = new Date("2026-07-05T12:00:00.000Z");
      const tooRecent = await insertPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        status: "queued",
        scheduledAt: new Date(now.getTime() - QUEUED_ORPHAN_GRACE_MS / 2),
      });

      const deps = makeDeps(tx);
      await runPublishReconcile(deps, { now });

      expect(deps.enqueued.map((d) => d.postId)).not.toContain(tooRecent);
    });
  });
});

describeIfDb("runPublishReconcile — stranded publishing posts", () => {
  it("closes out a publishing row that never reported an outcome", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const now = new Date("2026-07-05T12:00:00.000Z");
      const stranded = await insertPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        status: "publishing",
        updatedAt: new Date(now.getTime() - PUBLISHING_STALE_MS - MINUTE_MS),
      });

      const deps = makeDeps(tx);
      await runPublishReconcile(deps, { now });

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, stranded));
      expect(row?.status).toBe("failed");
      expect(row?.error).toMatchObject({ code: "internal_error" });
      // Fails loudly — the integrator gets a terminal event, not silence.
      expect(deps.events).toContain("post.failed");
    });
  });

  it("leaves a recently-started publish and an in-flight TikTok poll alone", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const now = new Date("2026-07-05T12:00:00.000Z");
      const base = {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        status: "publishing" as const,
      };

      // Started moments ago — a normal in-flight publish.
      const inFlight = await insertPost(tx, {
        ...base,
        updatedAt: new Date(now.getTime() - MINUTE_MS),
      });
      // Old, but a publish_id is stamped: the TikTok status poller owns it.
      const tiktokPolling = await insertPost(tx, {
        ...base,
        updatedAt: new Date(now.getTime() - PUBLISHING_STALE_MS - MINUTE_MS),
        platformCid: "tiktok-publish-id",
      });

      const deps = makeDeps(tx);
      await runPublishReconcile(deps, { now });

      for (const id of [inFlight, tiktokPolling]) {
        const [row] = await tx
          .select()
          .from(postsTable)
          .where(eq(postsTable.id, id));
        expect(row?.status).toBe("publishing");
      }
    });
  });
});
