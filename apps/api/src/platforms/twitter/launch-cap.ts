import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { LetmepostError } from "../../errors.js";
import { posts } from "../../db/schema/posts.js";
import type { DrizzleClient } from "../../db/index.js";

// X charges new developers on Pay-Per-Use with no free quota, so an
// unbounded publish loop = real money out the door.
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Only a post that actually went out costs money. Counting `rejected` and
 * `failed` rows here made the cap self-reinforcing: anything that broke a
 * publish (expired token, media rejected on a bad mime, upstream blip) also
 * consumed a slot, so a user hitting a run of failures burned the whole
 * 30-day allowance without a single tweet being created — and then got
 * `rate_limited` on every subsequent attempt, whose `failed` row consumed yet
 * another slot. The guard exists to bound the PPU bill, and a post X never
 * created is not billable.
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

  const rows = await db
    .select({
      // Oldest billable timestamp in the window — lets us compute a
      // tight `Retry-After` so the caller can poll back at exactly the
      // moment a slot frees instead of guessing.
      oldest: sql<Date>`MIN(${posts.createdAt})`,
      total: sql<number>`COUNT(*)`,
    })
    .from(posts)
    .where(
      and(
        eq(posts.accountId, accountId),
        gte(posts.createdAt, windowStart),
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
