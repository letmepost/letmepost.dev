import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { LetmepostError } from "../../errors.js";
import { posts } from "../../db/schema/posts.js";
import type { DrizzleClient } from "../../db/index.js";

// X charges new developers on Pay-Per-Use with no free quota, so an
// unbounded publish loop = real money out the door.
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Only a post that actually went out costs money. Counting `rejected` /
 * `failed` made the cap self-reinforcing: a broken publish consumed a slot,
 * and the resulting `rate_limited` failure consumed another.
 */
const BILLABLE_STATUSES = ["published"] as const;

function readCap(): number {
  const raw = process.env.TWITTER_LAUNCH_CAP_PER_ACCOUNT;
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

export async function assertTwitterLaunchCap(
  db: DrizzleClient,
  accountId: string,
): Promise<void> {
  const cap = readCap();
  const windowStart = new Date(Date.now() - WINDOW_MS);

  // Windowed on `publishedAt`, not `createdAt`: the charge happens when X
  // creates the tweet. A post scheduled 40 days ago and published today is
  // billable today, and a slot frees 30 days after publication — keying on
  // creation would miss the first and release the second early.
  const rows = await db
    .select({
      // Oldest billable publish in the window, for a tight `Retry-After`.
      oldest: sql<Date>`MIN(${posts.publishedAt})`,
      total: sql<number>`COUNT(*)`,
    })
    .from(posts)
    .where(
      and(
        eq(posts.accountId, accountId),
        gte(posts.publishedAt, windowStart),
        inArray(posts.status, [...BILLABLE_STATUSES]),
      ),
    );

  const row = rows[0];
  if (!row || row.total < cap) return;

  const oldest = row.oldest ? new Date(row.oldest) : windowStart;
  const retryAtMs = oldest.getTime() + WINDOW_MS;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAtMs - Date.now()) / 1000),
  );

  throw new LetmepostError({
    code: "rate_limited",
    status: 429,
    message: `X account is at the launch-window cap of ${cap} posts per 30 days.`,
    platform: "twitter",
    rule: "twitter.launch_cap.per_account",
    remediation: `Wait until the oldest billable post in the window falls out (~${retryAfterSeconds}s) or contact support to raise the cap.`,
    platformResponse: {
      cap,
      windowDays: 30,
      retryAfterSeconds,
      retryAt: new Date(retryAtMs).toISOString(),
    },
  });
}
