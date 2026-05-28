import "dotenv/config";
// Sentry init lives in `instrument.mjs`, loaded via `node --import` from
// the npm `start:worker` script. The captureUnexpected helper below is a
// no-op when DSN was missing at boot.
import { captureUnexpected } from "../observability/sentry.js";
import { Worker, UnrecoverableError } from "bullmq";
import { and, eq, isNull } from "drizzle-orm";
import { LetmepostError } from "../errors.js";
import { db } from "../db/instance.js";
import { posts as postsTable } from "../db/schema/posts.js";
import { webhookEndpoints } from "../db/schema/webhook_endpoints.js";
// Side-effect import: register every platform's AccountProvider so the
// refresh-token worker can look up providers for stored accounts.
import "../platforms/index.js";
import { getProvider } from "../platforms/index.js";
import {
  computeRefreshDelayMs,
  shouldEmitExpiringNotice,
} from "../platforms/_shared/refresh.js";
import { publishForAccount } from "../platforms/_shared/dispatch.js";
import { DrizzlePlatformAccountsRepository } from "../repositories/platform-accounts.js";
import { deliverWebhook } from "../webhooks/deliver.js";
import { createDefaultWebhookDispatcher } from "../webhooks/dispatch.js";
import { startTierInvalidationListener } from "../billing/invalidate.js";
import { runBillingDunning } from "./jobs/billing-dunning.js";
import { runPostsRetention } from "./jobs/posts-retention.js";
import { createRedisConnection } from "./connection.js";
import {
  QUEUE_NAMES,
  getBillingQueue,
  type BillingJobData,
  type OnboardingEmailJobData,
  type PublishJobData,
  type RefreshTokenJobData,
  type ValidateJobData,
  type WebhookDeliverJobData,
  closeAllQueues,
} from "./queues.js";
import { processOnboardingEmail } from "../email/onboarding/send.js";
import { createDefaultTokenRefreshEnqueuer } from "./refresh-enqueue.js";

/**
 * Worker entrypoint — `pnpm worker` starts this file. Boots one Worker per
 * queue against the shared Redis connection.
 *
 * The `publish` worker processes scheduled posts: re-reads the posts row,
 * decrypts the platform token, publishes, updates the row, and dispatches
 * the appropriate lifecycle event. Immediate posts don't touch this worker
 * — the request handler publishes inline.
 */

const connection = createRedisConnection();
const dispatcher = createDefaultWebhookDispatcher(db);

const publishWorker = new Worker<PublishJobData>(
  QUEUE_NAMES.publish,
  async (job) => {
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

    await db
      .update(postsTable)
      .set({ status: "publishing" })
      .where(eq(postsTable.id, post.id));

    const repo = new DrizzlePlatformAccountsRepository(db);
    const account = await repo.findById(post.accountId);
    if (!account) {
      const err = new LetmepostError({
        code: "internal_error",
        status: 500,
        message: "Platform account no longer exists — scheduled post cannot run.",
      });
      await finaliseFailure(post.id, err, account, organizationId, requestId);
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
      await finaliseFailure(post.id, err, account, organizationId, requestId);
      // 4xx-family errors → don't retry (preflight / platform_rejected /
      // platform_auth_failed). Transient errors bubble up so BullMQ retries.
      if (err instanceof LetmepostError) {
        const permanent =
          err.code === "preflight_failed" ||
          err.code === "platform_rejected" ||
          err.code === "platform_auth_failed" ||
          err.code === "validation_failed";
        if (permanent) {
          throw new UnrecoverableError(err.message);
        }
      }
      throw err;
    }
  },
  { connection },
);

async function finaliseFailure(
  postId: string,
  err: unknown,
  account: { id: string; platform: string; profileId: string } | null,
  organizationId: string,
  requestId: string | undefined,
): Promise<void> {
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

const validateWorker = new Worker<ValidateJobData>(
  QUEUE_NAMES.validate,
  async (_job) => {
    throw new Error(
      "validate worker not implemented — standalone validate endpoint lands in Phase 6",
    );
  },
  { connection },
);

const refreshEnqueuer = createDefaultTokenRefreshEnqueuer();

const refreshTokenWorker = new Worker<RefreshTokenJobData>(
  QUEUE_NAMES.refreshToken,
  async (job) => {
    const { platformAccountId, organizationId } = job.data;
    const repo = new DrizzlePlatformAccountsRepository(db);
    const account = await repo.findById(platformAccountId);
    if (!account) {
      // Account deleted between enqueue and run — nothing to refresh.
      throw new UnrecoverableError(
        `refresh-token: platform account ${platformAccountId} not found`,
      );
    }

    const provider = getProvider(account.platform);

    // Give integrators a heads-up *before* we try to silently refresh — only
    // for OAuth platforms. Bluesky (credentials) refreshes silently until
    // revocation.
    if (shouldEmitExpiringNotice(account.platform)) {
      await dispatcher
        .dispatch({
          organizationId,
          type: "token.expiring",
          data: {
            platform: account.platform,
            accountId: account.id,
            platformAccountId: account.platformAccountId,
            displayName: account.displayName,
            tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
          },
        })
        .catch((e: unknown) => {
          console.error("[refresh] token.expiring dispatch failed", e);
        });
    }

    try {
      const refreshed = await provider.refreshToken({
        token: account.token,
        tokenMetadata: account.tokenMetadata,
      });
      await repo.updateToken(account.id, {
        token: refreshed.token,
        tokenMetadata: refreshed.tokenMetadata,
        tokenExpiresAt: refreshed.tokenExpiresAt,
      });

      // Re-schedule the next refresh based on the fresh expiry.
      const nextDelay = computeRefreshDelayMs(
        { tokenExpiresAt: refreshed.tokenExpiresAt },
        provider.expiringHorizonMs,
      );
      if (nextDelay !== null) {
        await refreshEnqueuer.enqueue(
          { platformAccountId: account.id, organizationId },
          { delayMs: nextDelay },
        );
      }
      return { ok: true };
    } catch (err) {
      // Emit `token.revoked` on auth failure — this is what the integrator
      // needs to know to kick off human action (reconnect).
      const isAuthFailure =
        err instanceof LetmepostError && err.code === "platform_auth_failed";
      if (isAuthFailure) {
        await dispatcher
          .dispatch({
            organizationId,
            type: "token.revoked",
            data: {
              platform: account.platform,
              accountId: account.id,
              platformAccountId: account.platformAccountId,
              reason: err.message,
            },
          })
          .catch((e: unknown) => {
            console.error("[refresh] token.revoked dispatch failed", e);
          });
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  },
  { connection },
);

const webhookDeliverWorker = new Worker<WebhookDeliverJobData>(
  QUEUE_NAMES.webhookDeliver,
  async (job) => {
    const { endpointId, event, requestId } = job.data;

    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, endpointId),
          isNull(webhookEndpoints.disabledAt),
        ),
      )
      .limit(1);

    if (!endpoint) {
      throw new UnrecoverableError(
        `webhook endpoint ${endpointId} not found or disabled`,
      );
    }

    const deliverOptions: Parameters<typeof deliverWebhook>[2] = {};
    if (requestId) deliverOptions.requestId = requestId;
    const result = await deliverWebhook(
      {
        id: endpoint.id,
        url: endpoint.url,
        signingSecret: endpoint.signingSecret,
      },
      event,
      deliverOptions,
    );

    if (result.ok) return result;

    if (result.nonRetryable) {
      throw new UnrecoverableError(
        `webhook delivery rejected with ${result.status} (non-retryable)`,
      );
    }

    throw new Error(
      `webhook delivery failed with status ${result.status}${
        result.errorName ? ` (${result.errorName})` : ""
      }`,
    );
  },
  { connection },
);

const billingWorker = new Worker<BillingJobData>(
  QUEUE_NAMES.billing,
  async (job) => {
    if (job.data.kind === "dunning") {
      const result = await runBillingDunning(db, {
        webhookDispatcher: dispatcher,
      });
      return result;
    }
    if (job.data.kind === "retention") {
      const result = await runPostsRetention(db);
      return result;
    }
    throw new UnrecoverableError(
      `billing worker: unknown job kind ${(job.data as { kind?: string }).kind}`,
    );
  },
  { connection },
);

const onboardingEmailWorker = new Worker<OnboardingEmailJobData>(
  QUEUE_NAMES.onboardingEmail,
  async (job) => {
    const result = await processOnboardingEmail(db, job.data);
    return result;
  },
  { connection },
);

/**
 * Register repeatable schedules for the billing maintenance jobs. Idempotent
 * thanks to a stable `jobId` per kind; reboot adds nothing.
 *
 *   dunning   — every hour
 *   retention — daily at 03:30 UTC (off-peak everywhere)
 */
async function registerBillingSchedules(): Promise<void> {
  const queue = getBillingQueue();
  await queue
    .add(
      "dunning",
      { kind: "dunning" },
      {
        jobId: "billing-dunning-schedule",
        repeat: { every: 60 * 60 * 1000 },
      },
    )
    .catch((err: unknown) => {
      console.error("[worker] failed to register dunning schedule", err);
    });
  await queue
    .add(
      "retention",
      { kind: "retention" },
      {
        jobId: "billing-retention-schedule",
        repeat: { pattern: "30 3 * * *", tz: "Etc/UTC" },
      },
    )
    .catch((err: unknown) => {
      console.error("[worker] failed to register retention schedule", err);
    });
}

// Subscribe to cross-process tier-cache invalidation.
const stopTierListener = startTierInvalidationListener();

void registerBillingSchedules();

const workers = [
  publishWorker,
  validateWorker,
  refreshTokenWorker,
  webhookDeliverWorker,
  billingWorker,
  onboardingEmailWorker,
];

// Capture every job that exhausts its retries. BullMQ fires "failed" on
// each attempt; we only escalate to Sentry on the last attempt to keep
// noise down. UnrecoverableError jobs flag the failure immediately on
// attempt 0, so they go straight up.
for (const w of workers) {
  w.on("failed", (job, err) => {
    const isFinal =
      err instanceof UnrecoverableError ||
      !job ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isFinal) return;
    captureUnexpected(err, {
      tags: { surface: "worker", queue: w.name },
      extra: {
        job_id: job?.id,
        job_name: job?.name,
        attempts_made: job?.attemptsMade,
        attempts_max: job?.opts.attempts,
      },
    });
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`[worker] received ${signal}, draining…`);
  await Promise.all(workers.map((w) => w.close()));
  await closeAllQueues();
  await stopTierListener().catch(() => {});
  await connection.quit().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `[worker] started — queues: ${Object.values(QUEUE_NAMES).join(", ")}`,
);
