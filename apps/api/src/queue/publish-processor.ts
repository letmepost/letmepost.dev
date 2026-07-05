import { UnrecoverableError, type Queue } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { LetmepostError } from "../errors.js";
import type { DrizzleClient } from "../db/index.js";
import { posts as postsTable } from "../db/schema/posts.js";
import { DrizzlePlatformAccountsRepository } from "../repositories/platform-accounts.js";
import { publishForAccount } from "../platforms/_shared/dispatch.js";
import type { WebhookDispatcher } from "../webhooks/dispatch.js";
import {
  TIKTOK_PUBLISH_STATUS_POLL_DEADLINE_MS,
  tiktokPublishStatusPollDelayMs,
  type PublishJobData,
  type TikTokPublishStatusPollJobData,
} from "./queues.js";

/**
 * Dependencies the publish processor closes over. Injected so the processor
 * can be exercised in isolation (see tests/queue-publish-processor.test.ts)
 * without booting the whole worker / Redis stack.
 */
export interface PublishJobDeps {
  db: DrizzleClient;
  dispatcher: WebhookDispatcher;
  getTikTokPollQueue: () => Queue<TikTokPublishStatusPollJobData>;
}

/**
 * Minimal structural view of a BullMQ job. The real `Job<PublishJobData>` is
 * assignable to this, and tests can pass a plain object instead of a live job.
 */
export interface PublishJobLike {
  data: PublishJobData;
  attemptsMade: number;
  opts: { attempts?: number };
}

/**
 * Process one `publish` job: re-read the posts row, decrypt the account
 * token, publish, update the row, and dispatch the lifecycle event. Extracted
 * from the Worker callback so it's independently testable.
 */
export async function processPublishJob(
  job: PublishJobLike,
  deps: PublishJobDeps,
) {
  const { db, dispatcher } = deps;
  const { postId, organizationId, requestId } = job.data;

  const [post] = await db
    .select()
    .from(postsTable)
    .where(eq(postsTable.id, postId))
    .limit(1);
  if (!post) {
    throw new UnrecoverableError(
      `publish worker: posts row ${postId} not found — likely deleted between enqueue and run`,
    );
  }
  if (post.status === "published") {
    // Idempotent replay — someone already finalised this post.
    return { skipped: true, reason: "already-published" };
  }
  if (post.status === "canceled") {
    // The DELETE handler removes the BullMQ job, but a race can leave a
    // job already in flight when cancellation lands. Skip cleanly instead
    // of publishing a post the user asked us not to send.
    return { skipped: true, reason: "canceled" };
  }

  // Conditional transition to `publishing`. If the row was canceled (or
  // already moved by a parallel worker) between the SELECT above and
  // this UPDATE, the WHERE clause matches nothing, the row count is
  // zero, and we bail out instead of publishing a post the user
  // canceled mid-flight.
  const transitioned = await db
    .update(postsTable)
    .set({ status: "publishing" })
    .where(
      and(
        eq(postsTable.id, post.id),
        inArray(postsTable.status, ["queued", "validated"]),
      ),
    )
    .returning();
  if (transitioned.length === 0) {
    return { skipped: true, reason: "raced" };
  }

  const repo = new DrizzlePlatformAccountsRepository(db);
  const account = await repo.findById(post.accountId);
  if (!account) {
    const err = new LetmepostError({
      code: "internal_error",
      status: 500,
      message: "Platform account no longer exists — scheduled post cannot run.",
    });
    await finaliseFailure(deps, post.id, err, account, organizationId, requestId);
    throw new UnrecoverableError(err.message);
  }

  try {
    // Wire persisted media through to the publisher. Per-platform
    // overrides (`pinterest.boardId`, `threads.replyToId`, etc.) are
    // not yet stored on the posts row — scheduled posts currently
    // degrade to platform defaults for those. Adding columns +
    // back-fill is a Phase-7.5 follow-up; tracked in plan.md.
    const persistedMedia = Array.isArray(post.mediaRefs)
      ? (post.mediaRefs as Parameters<typeof publishForAccount>[1]["media"])
      : undefined;
    const result = await publishForAccount(
      account,
      {
        text: post.text,
        ...(persistedMedia && persistedMedia.length > 0
          ? {
              media: persistedMedia,
              mediaContext: {
                db,
                organizationId,
                profileId: account.profileId,
              },
            }
          : {}),
      },
      { db },
    );

    // TikTok's publish is async — the publisher returns `publishing`
    // with a publish_id stamped on `cid`. Enqueue a status-poll job
    // and leave the post row in `publishing` for the poller to flip
    // to `published` / `failed` on a terminal upstream state.
    if (result.status === "publishing" && account.platform === "tiktok") {
      await db
        .update(postsTable)
        .set({
          status: "publishing",
          platformCid: result.cid ?? null,
        })
        .where(eq(postsTable.id, post.id));
      await deps.getTikTokPollQueue().add(
        `${post.id}:0`,
        {
          postId: post.id,
          publishId: result.cid ?? result.id,
          platformAccountId: account.id,
          organizationId,
          attempt: 0,
          deadlineAt: Date.now() + TIKTOK_PUBLISH_STATUS_POLL_DEADLINE_MS,
          ...(requestId ? { requestId } : {}),
        },
        { delay: tiktokPublishStatusPollDelayMs(0) },
      );
      return { ok: true, publishing: true, cid: result.cid };
    }

    const publishedAt = new Date();
    await db
      .update(postsTable)
      .set({
        status: "published",
        platformUri: result.uri ?? null,
        platformCid: result.cid ?? null,
        publishedAt,
      })
      .where(eq(postsTable.id, post.id));

    await dispatcher.dispatch({
      organizationId,
      type: "post.published",
      data: {
        id: post.id,
        platform: account.platform,
        accountId: account.id,
        profileId: account.profileId,
        uri: result.uri,
        cid: result.cid,
        publishedAt: publishedAt.toISOString(),
      },
      ...(requestId ? { requestId } : {}),
    });

    return { ok: true, uri: result.uri, cid: result.cid };
  } catch (err) {
    // Permanent (4xx-family) failures — preflight / platform_rejected /
    // platform_auth_failed / validation_failed. Record the terminal status,
    // fire the lifecycle webhook, and tell BullMQ never to retry.
    if (
      err instanceof LetmepostError &&
      (err.code === "preflight_failed" ||
        err.code === "platform_rejected" ||
        err.code === "platform_auth_failed" ||
        err.code === "validation_failed")
    ) {
      await finaliseFailure(deps, post.id, err, account, organizationId, requestId);
      throw new UnrecoverableError(err.message);
    }

    // Retryable (e.g. platform_unavailable). Only record a terminal failure
    // + fire post.failed once BullMQ has exhausted every attempt. Before
    // then, hand the row back to a re-attemptable state so the NEXT run's
    // conditional transition (WHERE status IN ('queued','validated')) matches
    // and re-publishes instead of short-circuiting on status='failed'.
    //
    // bullmq 5.x increments job.attemptsMade AFTER the processor runs (inside
    // moveToFailed), so here it is the count of PRIOR failed attempts: 0 on
    // the first run, N-1 on the Nth. The current run is therefore the last
    // attempt when attemptsMade + 1 >= configured attempts (default 1).
    const maxAttempts = job.opts.attempts ?? 1;
    const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;
    if (isLastAttempt) {
      await finaliseFailure(deps, post.id, err, account, organizationId, requestId);
      throw err;
    }

    await db
      .update(postsTable)
      .set({ status: "validated" })
      .where(eq(postsTable.id, post.id));
    throw err;
  }
}

async function finaliseFailure(
  deps: Pick<PublishJobDeps, "db" | "dispatcher">,
  postId: string,
  err: unknown,
  account: { id: string; platform: string; profileId: string } | null,
  organizationId: string,
  requestId: string | undefined,
): Promise<void> {
  const { db, dispatcher } = deps;
  const status =
    err instanceof LetmepostError &&
    (err.code === "preflight_failed" ||
      err.code === "platform_rejected" ||
      err.code === "platform_auth_failed")
      ? "rejected"
      : "failed";
  const eventType = status === "rejected" ? "post.rejected" : "post.failed";

  const errorRecord =
    err instanceof LetmepostError
      ? {
          code: err.code,
          message: err.message,
          ...(err.rule ? { rule: err.rule } : {}),
          ...(err.platform ? { platform: err.platform } : {}),
          ...(err.platformResponse !== undefined
            ? { platformResponse: err.platformResponse }
            : {}),
          ...(err.remediation ? { remediation: err.remediation } : {}),
        }
      : {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        };

  await db
    .update(postsTable)
    .set({ status, error: errorRecord })
    .where(eq(postsTable.id, postId));

  if (!account) return;
  await dispatcher
    .dispatch({
      organizationId,
      type: eventType,
      data: {
        id: postId,
        platform: account.platform,
        accountId: account.id,
        profileId: account.profileId,
        error: errorRecord,
        rejectedAt: new Date().toISOString(),
      },
      ...(requestId ? { requestId } : {}),
    })
    .catch((e: unknown) => {
      console.error("[worker] failure-event dispatch failed", e);
    });
}
