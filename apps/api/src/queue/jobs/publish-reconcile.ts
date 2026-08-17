import { and, eq, isNull, lte } from "drizzle-orm";
import type { DrizzleClient } from "../../db/index.js";
import { platformAccounts } from "../../db/schema/platform_accounts.js";
import { posts as postsTable } from "../../db/schema/posts.js";
import type { WebhookDispatcher } from "../../webhooks/dispatch.js";
import type { PublishEnqueuer } from "../enqueue.js";

/**
 * Reconcile posts whose row and queue job have drifted apart — a `queued` row
 * whose enqueue never landed, or a `publishing` row abandoned by a crashed
 * worker. Both used to sit forever with no attempt and no terminal answer.
 *
 * Deliberately conservative: grace periods keep it clear of posts that are
 * simply mid-flight, and a job in a live state is always left alone.
 */

/** How far past `scheduledAt` before a missing job counts as lost. */
export const QUEUED_ORPHAN_GRACE_MS = 2 * 60 * 1000;

/**
 * How late a post may be and still be worth sending. Past this the row fails
 * loudly instead — an outage backlog would otherwise all fire at once the
 * moment the sweep starts working, which can't be taken back.
 */
export const QUEUED_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a row may sit in `publishing` before it counts as stranded. Above
 * TikTok's 30-minute poll deadline and far above any synchronous publish.
 */
export const PUBLISHING_STALE_MS = 45 * 60 * 1000;

/** Cap per sweep so one bad window can't turn into an unbounded batch. */
const MAX_ROWS_PER_SWEEP = 200;

/**
 * BullMQ states that mean a delivery attempt is still coming. Anything else
 * (`completed`, `failed`, `unknown`, or no job at all) means the queue is done
 * with this post and the row is on its own.
 */
const LIVE_JOB_STATES = new Set([
  "waiting",
  "waiting-children",
  "active",
  "delayed",
  "prioritized",
  "paused",
]);

export interface PublishReconcileDeps {
  db: DrizzleClient;
  enqueuer: PublishEnqueuer;
  dispatcher: WebhookDispatcher;
  /**
   * Current BullMQ state of the publish job for `postId`, or `null` when no
   * such job exists. Injected so the sweep is testable without Redis.
   */
  findJobState(postId: string): Promise<string | null>;
}

export interface PublishReconcileResult {
  /** Orphaned `queued` rows handed back to the publish queue. */
  requeued: number;
  /** Orphaned `queued` rows too late to send, closed out as failed. */
  expired: number;
  /** Stranded `publishing` rows closed out as failed. */
  stranded: number;
}

export async function runPublishReconcile(
  deps: PublishReconcileDeps,
  options: { now?: Date } = {},
): Promise<PublishReconcileResult> {
  const now = options.now ?? new Date();

  const { requeued, expired } = await requeueOrphanedQueued(deps, now);
  const stranded = await failStrandedPublishing(deps, now);

  if (requeued > 0 || expired > 0 || stranded > 0) {
    console.warn(
      `[reconcile] requeued ${requeued} orphaned queued post(s), expired ${expired} too-late post(s), failed ${stranded} stranded publishing post(s)`,
    );
  }
  return { requeued, expired, stranded };
}

async function requeueOrphanedQueued(
  deps: PublishReconcileDeps,
  now: Date,
): Promise<{ requeued: number; expired: number }> {
  const cutoff = new Date(now.getTime() - QUEUED_ORPHAN_GRACE_MS);
  const tooLateBefore = new Date(now.getTime() - QUEUED_ORPHAN_MAX_AGE_MS);

  const rows = await deps.db
    .select({
      id: postsTable.id,
      organizationId: postsTable.organizationId,
      accountId: postsTable.accountId,
      scheduledAt: postsTable.scheduledAt,
      platform: platformAccounts.platform,
      profileId: platformAccounts.profileId,
    })
    .from(postsTable)
    .leftJoin(platformAccounts, eq(platformAccounts.id, postsTable.accountId))
    .where(
      and(
        eq(postsTable.status, "queued"),
        lte(postsTable.scheduledAt, cutoff),
      ),
    )
    .limit(MAX_ROWS_PER_SWEEP);

  let requeued = 0;
  let expired = 0;
  for (const row of rows) {
    const state = await deps.findJobState(row.id);
    if (state !== null && LIVE_JOB_STATES.has(state)) continue;

    if (row.scheduledAt && row.scheduledAt < tooLateBefore) {
      const closed = await failQueuedRow(deps, row, {
        code: "internal_error",
        message:
          "This post was never handed to the publish queue, and is now too far past its scheduled time to send automatically.",
        remediation:
          "Nothing was sent to the platform. Re-create the post if you still want it published.",
      });
      if (closed) expired++;
      continue;
    }

    // A lingering `completed` / `failed` job still occupies the deterministic
    // job id (`removeOnComplete` keeps it for 7 days), and BullMQ silently
    // dedupes an `add()` against it — which would make this sweep a no-op
    // exactly when it's needed. Clear it, then enqueue for immediate run:
    // the scheduled time has already passed.
    await deps.enqueuer.remove(row.id);
    await deps.enqueuer.enqueue({
      postId: row.id,
      organizationId: row.organizationId,
    });
    requeued++;
  }
  return { requeued, expired };
}

/**
 * Move a `queued` row to `failed` and fire `post.failed`. Conditional on the
 * row still being `queued`, so a worker that picks it up mid-sweep wins.
 * Returns whether this call was the one that closed it.
 */
async function failQueuedRow(
  deps: PublishReconcileDeps,
  row: {
    id: string;
    organizationId: string;
    accountId: string | null;
    platform: string | null;
    profileId: string | null;
  },
  errorRecord: Record<string, unknown>,
): Promise<boolean> {
  const updated = await deps.db
    .update(postsTable)
    .set({ status: "failed", error: errorRecord })
    .where(and(eq(postsTable.id, row.id), eq(postsTable.status, "queued")))
    .returning();
  if (updated.length === 0) return false;

  if (row.accountId && row.platform && row.profileId) {
    await deps.dispatcher
      .dispatch({
        organizationId: row.organizationId,
        type: "post.failed",
        data: {
          id: row.id,
          platform: row.platform,
          accountId: row.accountId,
          profileId: row.profileId,
          error: errorRecord,
          rejectedAt: new Date().toISOString(),
        },
      })
      .catch((e: unknown) => {
        console.error("[reconcile] post.failed dispatch failed", e);
      });
  }
  return true;
}

async function failStrandedPublishing(
  deps: PublishReconcileDeps,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - PUBLISHING_STALE_MS);

  const rows = await deps.db
    .select({
      id: postsTable.id,
      organizationId: postsTable.organizationId,
      accountId: postsTable.accountId,
      platform: platformAccounts.platform,
      profileId: platformAccounts.profileId,
    })
    .from(postsTable)
    .leftJoin(
      platformAccounts,
      eq(platformAccounts.id, postsTable.accountId),
    )
    .where(
      and(
        eq(postsTable.status, "publishing"),
        lte(postsTable.updatedAt, cutoff),
        // TikTok stamps its publish_id here on accept and the status poller
        // owns the row until it reaches a terminal state. Leave those alone.
        isNull(postsTable.platformCid),
      ),
    )
    .limit(MAX_ROWS_PER_SWEEP);

  let stranded = 0;
  for (const row of rows) {
    const errorRecord = {
      code: "internal_error",
      message:
        "Publish was interrupted and never reported an outcome — the worker did not finish this post.",
      remediation:
        "Check the account on the platform before re-posting: the publish may have gone through upstream after we lost track of it.",
    };

    // Conditional on still being `publishing`, so a worker that comes back to
    // life mid-sweep and finalises the row wins instead of being overwritten.
    const updated = await deps.db
      .update(postsTable)
      .set({ status: "failed", error: errorRecord })
      .where(
        and(eq(postsTable.id, row.id), eq(postsTable.status, "publishing")),
      )
      .returning();
    if (updated.length === 0) continue;
    stranded++;

    if (!row.accountId || !row.platform || !row.profileId) continue;
    await deps.dispatcher
      .dispatch({
        organizationId: row.organizationId,
        type: "post.failed",
        data: {
          id: row.id,
          platform: row.platform,
          accountId: row.accountId,
          profileId: row.profileId,
          error: errorRecord,
          rejectedAt: new Date().toISOString(),
        },
      })
      .catch((e: unknown) => {
        console.error("[reconcile] post.failed dispatch failed", e);
      });
  }
  return stranded;
}
