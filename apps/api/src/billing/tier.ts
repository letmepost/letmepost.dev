import { eq } from "drizzle-orm";
import type { DrizzleClient } from "../db/index.js";
import { organization } from "../db/schema/auth.js";
import {
  billingSubscriptions,
  type BillingSubscription,
} from "../db/schema/billing_subscriptions.js";
import { tierCache } from "./cache.js";
import { TIERS, type BillingTier } from "./tiers.js";

const GRANDFATHER_DAYS = 60;

// Compute the grandfather end date for an org that pre-existed the billing
// rollout. Returns null when BILLING_ANNOUNCED_AT is unset, when the org
// was created on or after that date, or when announced-at + 60d has
// already passed.
function computeGrandfatheredUntil(orgCreatedAt: Date | null): Date | null {
  const raw = process.env.BILLING_ANNOUNCED_AT;
  if (!raw) return null;
  const announcedAt = new Date(raw);
  if (Number.isNaN(announcedAt.getTime())) return null;
  if (!orgCreatedAt || orgCreatedAt >= announcedAt) return null;
  const until = new Date(
    announcedAt.getTime() + GRANDFATHER_DAYS * 24 * 60 * 60 * 1000,
  );
  if (until <= new Date()) return null;
  return until;
}

export type BillingStatus = BillingSubscription["status"];

export type ResolvedTier = {
  tier: BillingTier;
  status: BillingStatus;
  quotaPerMonth: number;
  logRetentionDays: number;
  grandfathered: boolean;
  grandfatheredUntil: Date | null;
  delinquent: boolean;
  source:
    | "billing_disabled"
    | "grandfather"
    | "subscription"
    | "default_free";
  currentPeriodStart: Date | null;
  // End of the current billing period for paid tiers. Set for the cancelled
  // grace path so callers can render "service ends on X" copy.
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: Date | null;
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
    grandfatheredUntil: null,
    delinquent: false,
    source: "billing_disabled",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    cancelledAt: null,
  };
}

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
    // Lazy backfill: existing orgs created before BILLING_ANNOUNCED_AT get
    // a 60-day grace window stamped on the row at first read. New orgs
    // (created on or after announce) get nothing here.
    const [orgRow] = await db
      .select({ createdAt: organization.createdAt })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    const grandfatheredUntil = computeGrandfatheredUntil(
      orgRow?.createdAt ?? null,
    );
    const inserted = await db
      .insert(billingSubscriptions)
      .values({
        organizationId: orgId,
        tier: "free",
        status: "free",
        ...(grandfatheredUntil ? { grandfatheredUntil } : {}),
      })
      .onConflictDoNothing({ target: billingSubscriptions.organizationId })
      .returning();
    row = inserted[0];
    if (!row) {
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
      grandfatheredUntil: null,
      delinquent: false,
      source: "default_free",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
    };
  }

  const now = new Date();
  const tier = row.tier as BillingTier;
  const constants = TIERS[tier];
  const common = {
    currentPeriodStart: row.currentPeriodStart ?? null,
    currentPeriodEnd: row.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelledAt: row.cancelledAt ?? null,
    grandfatheredUntil: row.grandfatheredUntil ?? null,
  };

  // Grandfather window.
  if (row.grandfatheredUntil && row.grandfatheredUntil > now) {
    return {
      tier,
      status: row.status,
      quotaPerMonth: Infinity,
      logRetentionDays: constants.logRetentionDays,
      grandfathered: true,
      delinquent: false,
      source: "grandfather",
      ...common,
    };
  }

  // Delinquent: keep tier label so the dashboard renders the right upgrade
  // path, but cap the active quota at free-tier limits.
  if (row.status === "delinquent") {
    return {
      tier,
      status: row.status,
      quotaPerMonth: TIERS.free.quotaPerMonth,
      logRetentionDays: constants.logRetentionDays,
      grandfathered: false,
      delinquent: true,
      source: "subscription",
      ...common,
    };
  }

  // Cancelled but still inside the paid period: keep paid tier.
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
      ...common,
    };
  }

  return {
    tier,
    status: row.status,
    quotaPerMonth: constants.quotaPerMonth,
    logRetentionDays: constants.logRetentionDays,
    grandfathered: false,
    delinquent: false,
    source: row.tier === "free" ? "default_free" : "subscription",
    ...common,
  };
}
