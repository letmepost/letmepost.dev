import { LRUCache } from "lru-cache";
import type { ResolvedTier } from "./tier.js";

/**
 * In-process LRU cache for resolved tiers. 30s TTL keeps the cache fresh
 * while still letting hot publish loops skip the DB. Webhook handlers call
 * `invalidate(orgId)` after mutating billing_subscriptions; the cross-process
 * `invalidate.ts` module fans that out across the worker + web pods.
 */
const TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

const cache = new LRUCache<string, ResolvedTier>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
});

export const tierCache = {
  get(orgId: string): ResolvedTier | undefined {
    return cache.get(orgId);
  },
  set(orgId: string, resolved: ResolvedTier): void {
    cache.set(orgId, resolved);
  },
  invalidate(orgId: string): void {
    cache.delete(orgId);
  },
  clear(): void {
    cache.clear();
  },
};
