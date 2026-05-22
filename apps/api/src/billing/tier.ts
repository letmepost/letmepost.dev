import { eq } from "drizzle-orm";
import type { DrizzleClient } from "../db/index.js";
import {
  billingSubscriptions,
  type BillingSubscription,
} from "../db/schema/billing_subscriptions.js";
import { tierCache } from "./cache.js";
import { TIERS, type BillingTier } from "./tiers.js";

export type BillingStatus = BillingSubscription["status"];

export type ResolvedTier = {
  tier: BillingTier;
  status: BillingStatus;
  quotaPerMonth: number;
  logRetentionDays: number;
  grandfathered: boolean;
  delinquent: boolean;
  source:
    | "billing_disabled"
    | "grandfather"
    | "subscription"
    | "default_free";
  /**
   * End of the current billing period for paid tiers. Set for the cancelled
   * grace path so the caller can show "service ends on X" copy.
   */
  currentPeriodEnd: Date | null;
};

function billingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "true";
}

function syntheticSelfHost(): ResolvedTier {
  return {
    tier: "self_host",
    status: "free",
    quotaPerMonth: TIERS.self_host.quotaPerMonth,
    logRetentionDays: TIERS.self_host.logRetentionDays,
    grandfathered: false,
    delinquent: false,
    source: "billing_disabled",
    currentPeriodEnd: null,
  };
}

/**
 * Resolve the effective tier for an org. See the rules block above each
 * branch; the order matters because the rules layer on top of each other.
 *
 * 1. BILLING_ENABLED !== "true" -> self_host synthetic, never touches DB.
 * 2. No subscription row -> lazily insert a free row, return free.
 * 3. `grandfathered_until > now` -> keep tier, force quota = Infinity.
 * 4. `status === "delinquent"` -> keep tier, force quota = free quota.
 * 5. `status === "cancelled"` and still inside the paid period -> keep tier.
 * 6. Otherwise the row tier wins.
 *
 * The 30s LRU cache short-circuits the DB read on hot paths; webhook
 * handlers invalidate the cache when they mutate the row.
 */
export async function getOrgTier(
  db: DrizzleClient,
  orgId: string,
): Promise<ResolvedTier> {
  if (!billingEnabled()) {
    return syntheticSelfHost();
  }

  const cached = tierCache.get(orgId);
  if (cached) return cached;

  const resolved = await resolveFromDb(db, orgId);
  tierCache.set(orgId, resolved);
  return resolved;
}

async function resolveFromDb(
  db: DrizzleClient,
  orgId: string,
): Promise<ResolvedTier> {
  let [row] = await db
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.organizationId, orgId))
    .limit(1);

  if (!row) {
    const inserted = await db
      .insert(billingSubscriptions)
      .values({
        organizationId: orgId,
        tier: "free",
        status: "free",
      })
      .onConflictDoNothing({ target: billingSubscriptions.organizationId })
      .returning();
    row = inserted[0];
    if (!row) {
      // Lost the insert race — re-read what the other writer wrote.
      const reread = await db
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.organizationId, orgId))
        .limit(1);
      row = reread[0];
    }
  }

  if (!row) {
    return {
      tier: "free",
      status: "free",
      quotaPerMonth: TIERS.free.quotaPerMonth,
      logRetentionDays: TIERS.free.logRetentionDays,
      grandfathered: false,
      delinquent: false,
      source: "default_free",
      currentPeriodEnd: null,
    };
  }

  const now = new Date();
  const tier = row.tier as BillingTier;
  const constants = TIERS[tier];

  // 3. Grandfather window.
  if (row.grandfatheredUntil && row.grandfatheredUntil > now) {
    return {
      tier,
      status: row.status,
      quotaPerMonth: Infinity,
      logRetentionDays: constants.logRetentionDays,
      grandfathered: true,
      delinquent: false,
      source: "grandfather",
      currentPeriodEnd: row.currentPeriodEnd ?? null,
    };
  }

  // 4. Delinquent — keep the tier label so the dashboard shows the right
  // upgrade path, but cap the active quota at the free tier.
  if (row.status === "delinquent") {
    return {
      tier,
      status: row.status,
      quotaPerMonth: TIERS.free.quotaPerMonth,
      logRetentionDays: constants.logRetentionDays,
      grandfathered: false,
      delinquent: true,
      source: "subscription",
      currentPeriodEnd: row.currentPeriodEnd ?? null,
    };
  }

  // 5. Cancelled but still inside the paid period -> keep paid tier.
  if (
    row.status === "cancelled" &&
    row.currentPeriodEnd &&
    row.currentPeriodEnd > now
  ) {
    return {
      tier,
      status: row.status,
      quotaPerMonth: constants.quotaPerMonth,
      logRetentionDays: constants.logRetentionDays,
      grandfathered: false,
      delinquent: false,
      source: "subscription",
      currentPeriodEnd: row.currentPeriodEnd,
    };
  }

  // 6. Default — read tier off the row.
  return {
    tier,
    status: row.status,
    quotaPerMonth: constants.quotaPerMonth,
    logRetentionDays: constants.logRetentionDays,
    grandfathered: false,
    delinquent: false,
    source: row.tier === "free" ? "default_free" : "subscription",
    currentPeriodEnd: row.currentPeriodEnd ?? null,
  };
}
