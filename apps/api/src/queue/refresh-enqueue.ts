import type { RefreshTokenJobData } from "./queues.js";
import { getRefreshTokenQueue } from "./queues.js";

/**
 * Thin wrapper around the `refresh-token` queue, matching the PublishEnqueuer
 * pattern so tests can stub enqueue calls without a running Redis.
 *
 * Refresh jobs are always delayed: `delayMs` is how far out the refresh
 * should run, computed by the caller from `tokenExpiresAt - now - horizon`.
 *
 * The job id encodes the account id AND the absolute fire time so each
 * occurrence in the periodic refresh chain gets a DISTINCT id. This is
 * load-bearing: the refresh worker schedules the next refresh from inside the
 * job that just ran, and `removeOnComplete` keeps that just-finished job in
 * the completed set. A stable per-account id would make BullMQ dedup the
 * re-enqueue against the lingering completed job and silently drop it —
 * stopping the chain after a single refresh so tokens eventually expire
 * unrefreshed.
 *
 * Keying on the fire time keeps consecutive occurrences distinct while still
 * collapsing two schedules that target the SAME wake-up into one id (e.g. a
 * connect + an out-of-band re-schedule computed from the same expiry): the
 * delay is `expiry - horizon - now`, so `now + delay` reduces to the absolute
 * `expiry - horizon` regardless of when it was scheduled. The fire time is
 * bucketed to the whole second so sub-second scheduling latency between two
 * such schedulers doesn't defeat that dedup.
 */

export interface TokenRefreshEnqueuer {
  enqueue(data: RefreshTokenJobData, opts: { delayMs: number }): Promise<void>;
}

export const REFRESH_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 30_000 },
} as const;

/**
 * Build the BullMQ job id for a refresh occurrence firing at `fireAtEpochMs`.
 * Distinct fire times yield distinct ids (so consecutive occurrences in the
 * chain aren't deduped); the same fire-time second collapses to one id (so a
 * genuine duplicate of the same occurrence still dedups).
 *
 * BullMQ forbids `:` in custom job IDs — it uses it as an internal key
 * separator — so the parts are dash-joined.
 */
export function jobIdFor(accountId: string, fireAtEpochMs: number): string {
  const fireAtSecond = Math.floor(fireAtEpochMs / 1000);
  return `refresh-${accountId}-${fireAtSecond}`;
}

export function createDefaultTokenRefreshEnqueuer(): TokenRefreshEnqueuer {
  return {
    async enqueue(data, opts) {
      const delay = Math.max(0, opts.delayMs);
      await getRefreshTokenQueue().add("refresh-token", data, {
        ...REFRESH_JOB_OPTIONS,
        delay,
        jobId: jobIdFor(data.platformAccountId, Date.now() + delay),
      });
    },
  };
}
