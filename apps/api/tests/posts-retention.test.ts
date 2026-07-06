import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { runPostsRetention } from "../src/queue/jobs/posts-retention.js";
import { seed } from "../src/db/seed.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import type { DrizzleClient } from "../src/db/index.js";
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

const DAY_MS = 24 * 60 * 60 * 1000;

type PostStatus = (typeof postsTable.$inferInsert)["status"];

async function insertPost(
  tx: DrizzleClient,
  values: {
    organizationId: string;
    accountId: string;
    status: PostStatus;
    createdAt: Date;
    scheduledAt?: Date;
  },
): Promise<string> {
  const [row] = await tx
    .insert(postsTable)
    .values({
      organizationId: values.organizationId,
      accountId: values.accountId,
      status: values.status,
      text: `retention-${values.status}`,
      createdAt: values.createdAt,
      scheduledAt: values.scheduledAt ?? null,
    })
    .returning();
  if (!row) throw new Error("failed to insert post");
  return row.id;
}

describeIfDb("runPostsRetention (terminal-status filter)", () => {
  it("deletes only old terminal posts and never pending work", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);

      // Free tier (no billing_subscriptions row seeded) → 14 day retention.
      const now = new Date("2026-07-05T00:00:00.000Z");
      const old = new Date(now.getTime() - 30 * DAY_MS); // well past the cutoff
      const recent = new Date(now.getTime() - 1 * DAY_MS); // inside the window

      const base = {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
      };

      // Old + queued, scheduled to publish in the FUTURE. Must survive.
      const oldQueuedFuture = await insertPost(tx, {
        ...base,
        status: "queued",
        createdAt: old,
        scheduledAt: new Date(now.getTime() + 7 * DAY_MS),
      });
      // Old but still pending in other non-terminal states. Must survive.
      const oldValidated = await insertPost(tx, {
        ...base,
        status: "validated",
        createdAt: old,
      });
      const oldPublishing = await insertPost(tx, {
        ...base,
        status: "publishing",
        createdAt: old,
      });

      // Old + terminal. Must be deleted.
      const oldPublished = await insertPost(tx, {
        ...base,
        status: "published",
        createdAt: old,
      });
      const oldFailed = await insertPost(tx, {
        ...base,
        status: "failed",
        createdAt: old,
      });
      const oldRejected = await insertPost(tx, {
        ...base,
        status: "rejected",
        createdAt: old,
      });
      const oldCanceled = await insertPost(tx, {
        ...base,
        status: "canceled",
        createdAt: old,
      });

      // Control: recent terminal post inside the retention window. Must survive.
      const recentPublished = await insertPost(tx, {
        ...base,
        status: "published",
        createdAt: recent,
      });

      await runPostsRetention(tx, { now });

      const surviving = await tx
        .select({ id: postsTable.id })
        .from(postsTable)
        .where(
          and(
            eq(postsTable.organizationId, fixture.organizationId),
            inArray(postsTable.id, [
              oldQueuedFuture,
              oldValidated,
              oldPublishing,
              oldPublished,
              oldFailed,
              oldRejected,
              oldCanceled,
              recentPublished,
            ]),
          ),
        );
      const survivingIds = new Set(surviving.map((r) => r.id));

      // Pending work survives regardless of age.
      expect(survivingIds.has(oldQueuedFuture)).toBe(true);
      expect(survivingIds.has(oldValidated)).toBe(true);
      expect(survivingIds.has(oldPublishing)).toBe(true);

      // Old terminal posts are swept.
      expect(survivingIds.has(oldPublished)).toBe(false);
      expect(survivingIds.has(oldFailed)).toBe(false);
      expect(survivingIds.has(oldRejected)).toBe(false);
      expect(survivingIds.has(oldCanceled)).toBe(false);

      // Recent terminal post inside the window survives.
      expect(survivingIds.has(recentPublished)).toBe(true);
    });
  });
});
