import type { Redis } from "ioredis";
import { createRedisConnection } from "../queue/connection.js";
import { tierCache } from "./cache.js";

/**
 * Cross-process tier cache invalidation. Web + worker pods each subscribe to
 * the `billing:invalidate` Redis channel; publishing an org id clears that
 * key from every pod's in-process LRU.
 *
 * Falls back gracefully when Redis isn't reachable. Local publish still
 * clears the in-process cache, which is the only path that matters for the
 * single-process test runner.
 */
export const BILLING_INVALIDATE_CHANNEL = "billing:invalidate";

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) publisher = createRedisConnection();
  return publisher;
}

/**
 * Drop the cached tier locally and broadcast the same op to every other pod.
 * Always clears the in-process entry; the Redis publish is best-effort and
 * is swallowed on failure so a Redis outage can't break the publish path.
 */
export async function invalidateOrgTier(orgId: string): Promise<void> {
  tierCache.invalidate(orgId);
  try {
    await getPublisher().publish(BILLING_INVALIDATE_CHANNEL, orgId);
  } catch (err) {
    console.warn("[billing] tier cache fan-out failed", err);
  }
}

/**
 * Start the listener. Idempotent — call once per process. Returns a stop
 * function so tests / shutdown handlers can tear it down.
 */
export function startTierInvalidationListener(): () => Promise<void> {
  if (subscriber) {
    return async () => {};
  }
  const sub = createRedisConnection();
  subscriber = sub;
  sub.subscribe(BILLING_INVALIDATE_CHANNEL).catch((err: unknown) => {
    console.warn("[billing] tier invalidation subscribe failed", err);
  });
  sub.on("message", (channel, message) => {
    if (channel !== BILLING_INVALIDATE_CHANNEL) return;
    tierCache.invalidate(message);
  });
  return async () => {
    if (subscriber === sub) subscriber = null;
    await sub.quit().catch(() => {});
  };
}

export async function closeBillingInvalidation(): Promise<void> {
  if (publisher) {
    await publisher.quit().catch(() => {});
    publisher = null;
  }
  if (subscriber) {
    await subscriber.quit().catch(() => {});
    subscriber = null;
  }
}
