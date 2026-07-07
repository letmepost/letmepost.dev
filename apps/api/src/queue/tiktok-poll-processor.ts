import { UnrecoverableError, type Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { LetmepostError } from "../errors.js";
import type { DrizzleClient } from "../db/index.js";
import { posts as postsTable } from "../db/schema/posts.js";
import { DrizzlePlatformAccountsRepository } from "../repositories/platform-accounts.js";
import { pollTikTokPublishStatus } from "../platforms/tiktok/publisher.js";
import type { WebhookDispatcher } from "../webhooks/dispatch.js";
import {
  tiktokPublishStatusPollDelayMs,
  type TikTokPublishStatusPollJobData,
} from "./queues.js";

/**
 * Dependencies the TikTok poll processor closes over. Injected so the
 * processor can be exercised in isolation (see tests) without booting the
 * whole worker / Redis stack — mirrors PublishJobDeps.
 */
export interface TikTokPollJobDeps {
  db: DrizzleClient;
  dispatcher: WebhookDispatcher;
  getTikTokPollQueue: () => Queue<TikTokPublishStatusPollJobData>;
}

/**
 * Minimal structural view of a BullMQ job carrying the poll payload. The
 * real `Job<TikTokPublishStatusPollJobData>` is assignable to this, and
 * tests can pass a plain object.
 */
export interface TikTokPollJobLike {
  data: TikTokPublishStatusPollJobData;
}

/**
 * Process one `tiktok-publish-status-poll` job. Polls
 * /post/publish/status/fetch/ once and either:
 *
 *   - terminal success → updates the post row to `published`, dispatches
 *     `post.published`, returns.
 *   - terminal failure → updates the post row to `failed`, dispatches
 *     `post.failed`, returns (caller wraps in UnrecoverableError to prevent
 *     a BullMQ retry).
 *   - non-terminal      → re-enqueues with a bucketed delay computed from
 *     the attempt counter, unless the deadline has passed (→ `post.failed`).
 *
 * Both the immediate publish path (routes/posts.ts) and the scheduled path
 * (queue/publish-processor.ts) funnel accepted TikTok uploads through this
 * same reconciliation, so a post TikTok later fails never stays `published`.
 *
 * Extracted from the Worker callback so it's independently testable.
 */
export async function processTikTokPublishStatusPoll(
  job: TikTokPollJobLike,
  deps: TikTokPollJobDeps,
) {
  const { db, dispatcher } = deps;
  const {
    postId,
    publishId,
    platformAccountId,
    organizationId,
    attempt,
    deadlineAt,
    requestId,
  } = job.data;

  const repo = new DrizzlePlatformAccountsRepository(db);
  const account = await repo.findById(platformAccountId);
  if (!account) {
    throw new UnrecoverableError(
      `tiktok-publish-status-poll: account ${platformAccountId} not found`,
    );
  }

  const [post] = await db
    .select()
    .from(postsTable)
    .where(eq(postsTable.id, postId))
    .limit(1);
  if (!post) {
    throw new UnrecoverableError(
      `tiktok-publish-status-poll: post ${postId} not found`,
    );
  }
  if (
    post.status === "published" ||
    post.status === "failed" ||
    post.status === "rejected"
  ) {
    return { skipped: true, reason: `already-${post.status}` };
  }

  try {
    const result = await pollTikTokPublishStatus({
      accessToken: account.token,
      publishId,
      // No apiBase override at runtime; the env / publisher resolve it.
    });

    if (result.terminal && result.status === "published") {
      const publishedAt = new Date();
      await db
        .update(postsTable)
        .set({
          status: "published",
          platformUri: result.publicUri ?? null,
          platformCid: result.publishId,
          publishedAt,
        })
        .where(eq(postsTable.id, post.id));

      await dispatcher
        .dispatch({
          organizationId,
          type: "post.published",
          data: {
            id: post.id,
            platform: account.platform,
            accountId: account.id,
            profileId: account.profileId,
            uri: result.publicUri,
            cid: result.publishId,
            publishedAt: publishedAt.toISOString(),
          },
          ...(requestId ? { requestId } : {}),
        })
        .catch((e: unknown) => {
          console.error(
            "[tiktok-status-poll] post.published dispatch failed",
            e,
          );
        });
      return { ok: true, terminal: "published" };
    }

    if (result.terminal && result.status === "failed") {
      const errorRecord = {
        code: "platform_rejected",
        message: `TikTok rejected the publish: ${result.failReason ?? "unknown reason"}.`,
        platform: "tiktok",
        rule: "tiktok.publish.failed",
        ...(result.failReason
          ? { platformResponse: { fail_reason: result.failReason } }
          : {}),
        remediation:
          "TikTok rejected the upload. Common causes: resolution below 540 short-edge, codec mismatch, sandbox-account duration ceiling. Check the fail_reason for details.",
      };
      await db
        .update(postsTable)
        .set({ status: "failed", error: errorRecord })
        .where(eq(postsTable.id, post.id));
      await dispatcher
        .dispatch({
          organizationId,
          type: "post.failed",
          data: {
            id: post.id,
            platform: account.platform,
            accountId: account.id,
            profileId: account.profileId,
            error: errorRecord,
            rejectedAt: new Date().toISOString(),
          },
          ...(requestId ? { requestId } : {}),
        })
        .catch((e: unknown) => {
          console.error("[tiktok-status-poll] post.failed dispatch failed", e);
        });
      return { ok: true, terminal: "failed" };
    }

    // Non-terminal — re-enqueue if we still have budget.
    if (Date.now() >= deadlineAt) {
      const errorRecord = {
        code: "platform_unavailable",
        message:
          "TikTok did not reach a terminal publish state within 30 minutes.",
        platform: "tiktok",
        rule: "tiktok.publish.pending",
        remediation:
          "TikTok's async publish pipeline is unusually slow. The upload may still complete in the user's TikTok inbox; re-check via the TikTok app.",
      };
      await db
        .update(postsTable)
        .set({ status: "failed", error: errorRecord })
        .where(eq(postsTable.id, post.id));
      await dispatcher
        .dispatch({
          organizationId,
          type: "post.failed",
          data: {
            id: post.id,
            platform: account.platform,
            accountId: account.id,
            profileId: account.profileId,
            error: errorRecord,
            rejectedAt: new Date().toISOString(),
          },
          ...(requestId ? { requestId } : {}),
        })
        .catch((e: unknown) => {
          console.error(
            "[tiktok-status-poll] post.failed (deadline) dispatch failed",
            e,
          );
        });
      return { ok: true, terminal: "deadline" };
    }
    const nextDelay = tiktokPublishStatusPollDelayMs(attempt + 1);
    await deps.getTikTokPollQueue().add(
      `${postId}:${attempt + 1}`,
      {
        postId,
        publishId,
        platformAccountId,
        organizationId,
        attempt: attempt + 1,
        deadlineAt,
        ...(requestId ? { requestId } : {}),
      },
      { delay: nextDelay },
    );
    return {
      ok: true,
      terminal: null,
      upstream: result.terminal ? "(unreachable)" : result.upstreamState,
    };
  } catch (err) {
    if (err instanceof LetmepostError && err.code === "platform_auth_failed") {
      // Auth failure during polling — fold into post.failed and stop.
      const errorRecord = {
        code: err.code,
        message: err.message,
        ...(err.rule ? { rule: err.rule } : {}),
        ...(err.platform ? { platform: err.platform } : {}),
        ...(err.platformResponse !== undefined
          ? { platformResponse: err.platformResponse }
          : {}),
        ...(err.remediation ? { remediation: err.remediation } : {}),
      };
      await db
        .update(postsTable)
        .set({ status: "failed", error: errorRecord })
        .where(eq(postsTable.id, post.id));
      await dispatcher
        .dispatch({
          organizationId,
          type: "post.failed",
          data: {
            id: post.id,
            platform: account.platform,
            accountId: account.id,
            profileId: account.profileId,
            error: errorRecord,
            rejectedAt: new Date().toISOString(),
          },
          ...(requestId ? { requestId } : {}),
        })
        .catch(() => {});
      throw new UnrecoverableError(err.message);
    }
    // Transient: bubble up so BullMQ retries.
    throw err;
  }
}
