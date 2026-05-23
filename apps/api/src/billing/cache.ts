import { LRUCache } from "lru-cache";
import type { ResolvedTier } from "./tier.js";

// 30s TTL: short enough that a missed pub/sub message self-heals quickly,
// long enough to spare the DB on hot publish loops.
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
