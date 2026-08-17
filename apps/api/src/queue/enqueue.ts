import type { PublishJobData } from "./queues.js";
import { getPublishQueue } from "./queues.js";

/**
 * Thin wrapper around the `publish` queue so tests can inject a stub and
 * assert enqueues without a running Redis.
 *
 * `remove` + the deterministic jobId built by `publishJobId` exist so the
 * reschedule (PATCH) and cancel (DELETE) endpoints can find and replace a
 * scheduled job by post id without tracking BullMQ-assigned ids on the row.
 */
export interface PublishEnqueuer {
  enqueue(data: PublishJobData, opts?: { delayMs?: number }): Promise<void>;
  remove(postId: string): Promise<void>;
}

export const PUBLISH_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 10_000 },
} as const;

/**
 * Deterministic job id for a post's publish job.
 *
 * Dash-joined, NOT colon-joined. BullMQ rejects a custom job id containing
 * `:` unless it happens to split into exactly three parts — it uses the colon
 * as its internal Redis key separator (`bullmq/classes/job.js`, "Custom Id
 * cannot contain :"). `publish:<uuid>` splits into two, so every enqueue
 * threw, the posts row stayed durably `queued` with no job behind it, and the
 * caller got a 500. Scheduled publishing was down entirely; only the
 * immediate path, which never enqueues, still worked.
 *
 * The three-part escape hatch is a documented compatibility branch BullMQ
 * intends to drop, so don't reach for it. Keep this dash-joined —
 * `refresh-enqueue.ts` makes the same choice for the same reason.
 */
export function publishJobId(postId: string): string {
  return `publish-${postId}`;
}

export function createDefaultPublishEnqueuer(): PublishEnqueuer {
  return {
    async enqueue(data, opts) {
      const delay = opts?.delayMs;
      await getPublishQueue().add("publish", data, {
        ...PUBLISH_JOB_OPTIONS,
        jobId: publishJobId(data.postId),
        ...(delay && delay > 0 ? { delay } : {}),
      });
    },
    async remove(postId) {
      const job = await getPublishQueue().getJob(publishJobId(postId));
      if (job) await job.remove();
    },
  };
}
