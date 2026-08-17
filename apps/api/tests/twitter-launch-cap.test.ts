import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertTwitterLaunchCap } from "../src/platforms/twitter/launch-cap.js";
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

const CAP_ENV = "TWITTER_LAUNCH_CAP_PER_ACCOUNT";
const previous = process.env[CAP_ENV];

beforeEach(() => {
  process.env[CAP_ENV] = "3";
});

afterEach(() => {
  if (previous === undefined) delete process.env[CAP_ENV];
  else process.env[CAP_ENV] = previous;
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

type PostStatus = (typeof postsTable.$inferInsert)["status"];

async function insertPosts(
  tx: DrizzleClient,
  base: { organizationId: string; accountId: string },
  statuses: PostStatus[],
): Promise<void> {
  for (const status of statuses) {
    await tx.insert(postsTable).values({
      organizationId: base.organizationId,
      accountId: base.accountId,
      status,
      text: `cap-${status}`,
    });
  }
}

describeIfDb("assertTwitterLaunchCap", () => {
  it("does not count posts that never reached X", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const base = {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
      };

      // Well past a cap of 3 in raw row count, but none of these cost a
      // thing: a rejected preflight or a failed publish creates no tweet.
      // Counting them used to make the cap self-reinforcing — a run of
      // failures locked the account out, and each lockout wrote another
      // `failed` row that pushed the window further out.
      await insertPosts(tx, base, [
        "failed",
        "failed",
        "rejected",
        "rejected",
        "canceled",
        "queued",
        "publishing",
      ]);

      await expect(assertTwitterLaunchCap(tx, base.accountId)).resolves
        .toBeUndefined();
    });
  });

  it("still caps on posts that actually published", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const base = {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
      };

      await insertPosts(tx, base, ["published", "published"]);
      await expect(assertTwitterLaunchCap(tx, base.accountId)).resolves
        .toBeUndefined();

      await insertPosts(tx, base, ["published"]);
      await expect(
        assertTwitterLaunchCap(tx, base.accountId),
      ).rejects.toMatchObject({
        code: "rate_limited",
        status: 429,
        platform: "twitter",
        rule: "twitter.launch_cap.per_account",
      });
    });
  });
});
