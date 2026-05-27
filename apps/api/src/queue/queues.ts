import { Queue, type QueueOptions } from "bullmq";
import type { WebhookEvent } from "@letmepost/schemas";
import { createRedisConnection } from "./connection.js";

/**
 * BullMQ queue registry. Four queues cover the Phase 4 scope:
 *   - publish          Fan-out post publishing (integration step wires the
 *                      publisher onto this — not done in this slice).
 *   - validate         Preflight-only runs (dry run, scheduled ahead of publish).
 *   - refresh-token    OAuth-token refresh scheduler per platform.
 *   - webhook-deliver  Outbound webhook delivery with retries + DLQ.
 *
 * Payload types are intentionally minimal — the real shapes land alongside the
 * integration step on main. The `webhook-deliver` payload IS fully specified
 * here because its worker is implemented in this slice.
 */

export const QUEUE_NAMES = {
  publish: "publish",
  validate: "validate",
  refreshToken: "refresh-token",
  webhookDeliver: "webhook-deliver",
  billing: "billing",
  onboardingEmail: "onboarding-email",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Publish a queued post. The worker re-reads the `posts` row by id to pick
 * up text, media, first-comment, and the account reference — we don't
 * serialize credentials through Redis.
 */
export type PublishJobData = {
  postId: string;
  organizationId: string;
  /** Correlates back to the inbound request that enqueued this. */
  requestId?: string;
};

/** Run preflight validation without publishing. Stubbed. */
export type ValidateJobData = {
  postId: string;
  organizationId: string;
  [extra: string]: unknown;
};

/** Refresh an OAuth token before it expires. Stubbed. */
export type RefreshTokenJobData = {
  platformAccountId: string;
  organizationId: string;
  [extra: string]: unknown;
};

/**
 * Deliver one webhook event to one endpoint. `attempt` is informational —
 * BullMQ tracks the authoritative attempt count on the job itself.
 */
export type WebhookDeliverJobData = {
  endpointId: string;
  organizationId: string;
  event: WebhookEvent;
  /** Correlates the inbound request that produced this event. */
  requestId?: string;
};

/**
 * Periodic billing maintenance. `kind` discriminates which job runs:
 *   - "dunning"   — hourly past_due → delinquent sweep
 *   - "retention" — nightly per-org log cleanup
 */
export type BillingJobData =
  | { kind: "dunning" }
  | { kind: "retention" };

/**
 * Founder-voice onboarding sequence. One job per email, scheduled at
 * signup time with a `delay`. `kind` picks the template; the worker
 * checks the user's current state before sending so e.g. the "stuck?"
 * email skips users who already connected an account.
 */
export type OnboardingEmailJobData = {
  userId: string;
  email: string;
  firstName: string;
  kind: "d0_welcome" | "d1_first_post" | "d3_stuck" | "d5_webhooks" | "d7_one_question";
};

const defaultJobOptions: QueueOptions["defaultJobOptions"] = {
  removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
};

function buildQueue(name: QueueName): Queue {
  const opts: QueueOptions = {
    connection: createRedisConnection(),
    ...(defaultJobOptions ? { defaultJobOptions } : {}),
  };
  return new Queue(name, opts);
}

// Lazy singletons so importing this module doesn't open Redis connections
// during tests that never actually enqueue anything.
let _publishQueue: Queue<PublishJobData> | null = null;
let _validateQueue: Queue<ValidateJobData> | null = null;
let _refreshTokenQueue: Queue<RefreshTokenJobData> | null = null;
let _webhookDeliverQueue: Queue<WebhookDeliverJobData> | null = null;
let _billingQueue: Queue<BillingJobData> | null = null;
let _onboardingEmailQueue: Queue<OnboardingEmailJobData> | null = null;

export function getPublishQueue(): Queue<PublishJobData> {
  if (!_publishQueue)
    _publishQueue = buildQueue(QUEUE_NAMES.publish) as Queue<PublishJobData>;
  return _publishQueue;
}

export function getValidateQueue(): Queue<ValidateJobData> {
  if (!_validateQueue)
    _validateQueue = buildQueue(QUEUE_NAMES.validate) as Queue<ValidateJobData>;
  return _validateQueue;
}

export function getRefreshTokenQueue(): Queue<RefreshTokenJobData> {
  if (!_refreshTokenQueue)
    _refreshTokenQueue = buildQueue(
      QUEUE_NAMES.refreshToken,
    ) as Queue<RefreshTokenJobData>;
  return _refreshTokenQueue;
}

export function getWebhookDeliverQueue(): Queue<WebhookDeliverJobData> {
  if (!_webhookDeliverQueue)
    _webhookDeliverQueue = buildQueue(
      QUEUE_NAMES.webhookDeliver,
    ) as Queue<WebhookDeliverJobData>;
  return _webhookDeliverQueue;
}

export function getBillingQueue(): Queue<BillingJobData> {
  if (!_billingQueue)
    _billingQueue = buildQueue(QUEUE_NAMES.billing) as Queue<BillingJobData>;
  return _billingQueue;
}

export function getOnboardingEmailQueue(): Queue<OnboardingEmailJobData> {
  if (!_onboardingEmailQueue)
    _onboardingEmailQueue = buildQueue(
      QUEUE_NAMES.onboardingEmail,
    ) as Queue<OnboardingEmailJobData>;
  return _onboardingEmailQueue;
}

/**
 * Retry policy for webhook delivery — see `src/webhooks/deliver.ts` for the
 * rationale. 8 attempts with exponential backoff starting at 5s. After the
 * final attempt BullMQ moves the job to its "failed" set, which is our DLQ.
 */
export const WEBHOOK_DELIVER_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential" as const, delay: 5000 },
} as const;

/** Close all open queue connections. Useful on worker shutdown. */
export async function closeAllQueues(): Promise<void> {
  await Promise.all([
    _publishQueue?.close(),
    _validateQueue?.close(),
    _refreshTokenQueue?.close(),
    _webhookDeliverQueue?.close(),
    _billingQueue?.close(),
    _onboardingEmailQueue?.close(),
  ]);
  _publishQueue = null;
  _validateQueue = null;
  _refreshTokenQueue = null;
  _webhookDeliverQueue = null;
  _billingQueue = null;
  _onboardingEmailQueue = null;
}
