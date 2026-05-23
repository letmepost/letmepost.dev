import type { Redis } from "ioredis";
import { createRedisConnection } from "../queue/connection.js";
import { tierCache } from "./cache.js";

export const BILLING_INVALIDATE_CHANNEL = "billing:invalidate";

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) publisher = createRedisConnection();
  return publisher;
}

// Drop the local cache entry and broadcast the invalidation. Redis publish
// is best-effort: a Redis outage cannot break a successful publish path.
export async function invalidateOrgTier(orgId: string): Promise<void> {
  tierCache.invalidate(orgId);
  try {
    await getPublisher().publish(BILLING_INVALIDATE_CHANNEL, orgId);
  } catch (err) {
    console.warn("[billing] tier cache fan-out failed", err);
  }
}

// Idempotent: call once per process. Returns a stop function for shutdown.
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
