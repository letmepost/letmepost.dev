import type {
  PublishJobData,
  TikTokPublishStatusPollJobData,
} from "./queues.js";
import {
  getPublishQueue,
  getTikTokPublishStatusPollQueue,
  TIKTOK_PUBLISH_STATUS_POLL_DEADLINE_MS,
  tiktokPublishStatusPollDelayMs,
} from "./queues.js";

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

export function publishJobId(postId: string): string {
  return `publish:${postId}`;
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

// Kicks off the first TikTok publish-status poll for an async (inbox) upload
// from the synchronous request path, mirroring what the scheduled worker does.
export type TikTokStatusPollInput = Omit<
  TikTokPublishStatusPollJobData,
  "attempt" | "deadlineAt"
>;

export interface TikTokStatusPollEnqueuer {
  enqueue(data: TikTokStatusPollInput): Promise<void>;
}

export function createDefaultTikTokStatusPollEnqueuer(): TikTokStatusPollEnqueuer {
  return {
    async enqueue(data) {
      await getTikTokPublishStatusPollQueue().add(
        `${data.postId}:0`,
        {
          ...data,
          attempt: 0,
          deadlineAt: Date.now() + TIKTOK_PUBLISH_STATUS_POLL_DEADLINE_MS,
        },
        { delay: tiktokPublishStatusPollDelayMs(0) },
      );
    },
  };
}
