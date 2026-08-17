import { and, eq, inArray, or, sql } from "drizzle-orm";
import { LetmepostError } from "../../errors.js";
import { posts } from "../../db/schema/posts.js";
import type { DrizzleClient } from "../../db/index.js";

// X charges new developers on Pay-Per-Use with no free quota, so an
// unbounded publish loop = real money out the door.
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What counts against the cap: attempts that actually reached X.
 *
 * Counting every `rejected` / `failed` row made the cap self-reinforcing — a
 * preflight rejection or the cap's own `rate_limited` row consumed a slot
 * without X ever being called, so a run of failures locked the account out.
 * Counting only `published` went too far the other way and removed the spend
 * ceiling the guard exists for: a loop of 401s is still a loop of real API
 * calls.
 *
 * So bill on contact with X — a published tweet, or a failure X itself
 * returned — and never on one we produced locally.
 */
const UPSTREAM_ERROR_CODES = ["platform_rejected", "platform_auth_failed"];

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

  // Billed at the moment of the call, so the window keys on `publishedAt`
  // where we have it and falls back to `createdAt` for attempts X refused.
  // Keying on `createdAt` alone would miss a post scheduled 40 days ago and
  // published today, and would free its slot 30 days early.
  const billableAt = sql`COALESCE(${posts.publishedAt}, ${posts.createdAt})`;
  const rows = await db
    .select({
      // Oldest billable call in the window, for a tight `Retry-After`.
      oldest: sql<Date>`MIN(${billableAt})`,
      total: sql<number>`COUNT(*)`,
    })
    .from(posts)
    .where(
      and(
        eq(posts.accountId, accountId),
        // ISO text + cast: `billableAt` is a raw expression with no column
        // type, so the driver can't serialize a JS Date against it.
        sql`${billableAt} >= ${windowStart.toISOString()}::timestamptz`,
        or(
          eq(posts.status, "published"),
          inArray(sql`${posts.error}->>'code'`, UPSTREAM_ERROR_CODES),
        ),
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
