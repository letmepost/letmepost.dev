import "dotenv/config";
// Sentry init lives in `instrument.mjs`, loaded via `node --import` from
// the npm `start:worker` script. The captureUnexpected helper below is a
// no-op when DSN was missing at boot.
import { captureUnexpected } from "../observability/sentry.js";
import { Worker, UnrecoverableError } from "bullmq";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { LetmepostError } from "../errors.js";
import { db } from "../db/instance.js";
import { webhookEndpoints } from "../db/schema/webhook_endpoints.js";
// Side-effect import: register every platform's AccountProvider so the
// refresh-token worker can look up providers for stored accounts.
import "../platforms/index.js";
import { getProvider } from "../platforms/index.js";
import {
  computeRefreshDelayMs,
  shouldEmitExpiringNotice,
} from "../platforms/_shared/refresh.js";
import { DrizzlePlatformAccountsRepository } from "../repositories/platform-accounts.js";
import { deliverWebhook } from "../webhooks/deliver.js";
import { createDefaultWebhookDispatcher } from "../webhooks/dispatch.js";
import { processPublishJob } from "./publish-processor.js";
import { processTikTokPublishStatusPoll } from "./tiktok-poll-processor.js";
import { startTierInvalidationListener } from "../billing/invalidate.js";
import { runBillingDunning } from "./jobs/billing-dunning.js";
import { runPostsRetention } from "./jobs/posts-retention.js";
import { runPublishReconcile } from "./jobs/publish-reconcile.js";
import { createDefaultPublishEnqueuer, publishJobId } from "./enqueue.js";
import { createRedisConnection } from "./connection.js";
import {
  QUEUE_NAMES,
  getBillingQueue,
  getPublishQueue,
  type BillingJobData,
  type OnboardingEmailJobData,
  type PublishJobData,
  type RefreshTokenJobData,
  type TikTokPublishStatusPollJobData,
  type ValidateJobData,
  type WebhookDeliverJobData,
  closeAllQueues,
  getTikTokPublishStatusPollQueue,
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
const publishEnqueuer = createDefaultPublishEnqueuer();

const publishWorker = new Worker<PublishJobData>(
  QUEUE_NAMES.publish,
  (job) =>
    processPublishJob(job, {
      db,
      dispatcher,
      getTikTokPollQueue: getTikTokPublishStatusPollQueue,
    }),
  { connection },
);

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
    if (job.data.kind === "publish-reconcile") {
      const result = await runPublishReconcile({
        db,
        dispatcher,
        enqueuer: publishEnqueuer,
        async findJobState(postId) {
          const existing = await getPublishQueue().getJob(publishJobId(postId));
          return existing ? await existing.getState() : null;
        },
      });
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
 * Register repeatable schedules for the maintenance jobs. Idempotent thanks
 * to a stable `jobId` per kind; reboot adds nothing.
 *
 *   dunning           — every hour
 *   retention         — daily at 03:30 UTC (off-peak everywhere)
 *   publish-reconcile — every 5 minutes
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
  await queue
    .add(
      "publish-reconcile",
      { kind: "publish-reconcile" },
      {
        jobId: "publish-reconcile-schedule",
        repeat: { every: 5 * 60 * 1000 },
      },
    )
    .catch((err: unknown) => {
      console.error(
        "[worker] failed to register publish-reconcile schedule",
        err,
      );
    });
}

// Subscribe to cross-process tier-cache invalidation.
const stopTierListener = startTierInvalidationListener();

void registerBillingSchedules();

// TikTok publish-status poller — reconciles accepted uploads to their
// terminal state. Logic lives in processTikTokPublishStatusPoll so it's
// testable without a live Worker / Redis (mirrors processPublishJob).
const tiktokPublishStatusPollWorker =
  new Worker<TikTokPublishStatusPollJobData>(
    QUEUE_NAMES.tiktokPublishStatusPoll,
    (job) =>
      processTikTokPublishStatusPoll(job, {
        db,
        dispatcher,
        getTikTokPollQueue: getTikTokPublishStatusPollQueue,
      }),
    { connection },
  );

const workers = [
  publishWorker,
  validateWorker,
  refreshTokenWorker,
  webhookDeliverWorker,
  billingWorker,
  onboardingEmailWorker,
  tiktokPublishStatusPollWorker,
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
