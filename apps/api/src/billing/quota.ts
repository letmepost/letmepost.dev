import { and, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleClient } from "../db/index.js";
import { billingUsage } from "../db/schema/billing_usage.js";
import { LetmepostError } from "../errors.js";
import type { WebhookDispatcher } from "../webhooks/dispatch.js";
import { periodFor, periodResetAt } from "./period.js";
import { getOrgTier, type ResolvedTier } from "./tier.js";

export type QuotaResult = {
  newCount: number;
  quota: number;
  period: string;
  resetAt: Date;
};

// Drizzle TS column names (NOT the DB column names) so `set` targets a
// real key. Using snake_case here was a real bug: drizzle silently dropped
// the assignment and every call dispatched.
type ThresholdMark = "warning80SentAt" | "exceededSentAt";

// Atomic post-quota check + increment. The conditional UPSERT in
// tryIncrement is the load-bearing guarantee: two concurrent requests
// cannot double-spend the last slot under the cap.
export async function checkAndIncrementQuota(
  db: DrizzleClient,
  orgId: string,
  cost: number,
  options: {
    webhookDispatcher?: WebhookDispatcher;
  } = {},
): Promise<QuotaResult> {
  if (cost <= 0) {
    throw new Error("checkAndIncrementQuota: cost must be positive");
  }
  const tier = await getOrgTier(db, orgId);
  const period = periodFor();
  const resetAt = periodResetAt();
  const quota = tier.quotaPerMonth;

  if (!Number.isFinite(quota)) {
    // Infinity quota (self_host, grandfather). Still record the count so
    // the dashboard usage view has data, but skip the gate.
    const newCount = await unboundedIncrement(db, orgId, period, cost);
    return { newCount, quota, period, resetAt };
  }

  // Reject single requests that exceed the entire quota up front; the
  // ON CONFLICT predicate in tryIncrement only fires on the second-and-later
  // insert for a period, so a single `cost > quota` first insert would
  // otherwise land unconditionally.
  if (cost > quota) {
    await markThresholdAndDispatch(db, orgId, period, "exceededSentAt", {
      tier,
      quota,
      resetAt,
      currentCount: await readCurrentCount(db, orgId, period),
      ...(options.webhookDispatcher
        ? { webhookDispatcher: options.webhookDispatcher }
        : {}),
      eventType: "quota.exceeded",
    });
    throw new LetmepostError({
      code: "quota_exceeded",
      status: 429,
      message: `Request cost (${cost}) exceeds the monthly quota (${quota}).`,
      rule: "billing.posts.monthly_cap",
      remediation:
        "Reduce the number of targets per request or upgrade your plan.",
      platformResponse: { period, quota, cost, resetAt: resetAt.toISOString() },
    });
  }

  const newCount = await tryIncrement(db, orgId, period, cost, quota);

  if (newCount === null) {
    // Increment rejected — cap hit. Emit a one-shot `quota.exceeded` so the
    // org's webhook integrators see it once per period.
    await markThresholdAndDispatch(db, orgId, period, "exceededSentAt", {
      tier,
      quota,
      resetAt,
      currentCount: await readCurrentCount(db, orgId, period),
      ...(options.webhookDispatcher
        ? { webhookDispatcher: options.webhookDispatcher }
        : {}),
      eventType: "quota.exceeded",
    });

    throw new LetmepostError({
      code: "quota_exceeded",
      status: 429,
      message: `Monthly post quota of ${quota} has been reached for this organization.`,
      rule: "billing.posts.monthly_cap",
      remediation:
        "Upgrade your plan at https://dashboard.letmepost.dev/billing or wait until the quota resets at the start of next month.",
      platformResponse: {
        period,
        quota,
        resetAt: resetAt.toISOString(),
      },
    });
  }

  // 80% threshold notice — only fires when we cross the line. The mark column
  // is sticky for the rest of the period.
  if (quota > 0 && newCount >= Math.floor(quota * 0.8)) {
    await markThresholdAndDispatch(db, orgId, period, "warning80SentAt", {
      tier,
      quota,
      resetAt,
      currentCount: newCount,
      ...(options.webhookDispatcher
        ? { webhookDispatcher: options.webhookDispatcher }
        : {}),
      eventType: "quota.warning",
    });
  }

  return { newCount, quota, period, resetAt };
}

// Conditional atomic UPSERT. On conflict we add the cost only when the
// total stays under the quota. Returns null when the cap was hit.
async function tryIncrement(
  db: DrizzleClient,
  orgId: string,
  period: string,
  cost: number,
  quota: number,
): Promise<number | null> {
  const rows = await db
    .insert(billingUsage)
    .values({ organizationId: orgId, period, postsCount: cost })
    .onConflictDoUpdate({
      target: [billingUsage.organizationId, billingUsage.period],
      set: {
        postsCount: sql`${billingUsage.postsCount} + EXCLUDED.posts_count`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${billingUsage.postsCount} + EXCLUDED.posts_count <= ${quota}`,
    })
    .returning();

  const row = rows[0];
  return row ? row.postsCount : null;
}

// Increment without the cap guard, for Infinity-quota tiers.
async function unboundedIncrement(
  db: DrizzleClient,
  orgId: string,
  period: string,
  cost: number,
): Promise<number> {
  const rows = await db
    .insert(billingUsage)
    .values({ organizationId: orgId, period, postsCount: cost })
    .onConflictDoUpdate({
      target: [billingUsage.organizationId, billingUsage.period],
      set: {
        postsCount: sql`${billingUsage.postsCount} + EXCLUDED.posts_count`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  return rows[0]?.postsCount ?? cost;
}

async function readCurrentCount(
  db: DrizzleClient,
  orgId: string,
  period: string,
): Promise<number> {
  const [row] = await db
    .select({ postsCount: billingUsage.postsCount })
    .from(billingUsage)
    .where(
      and(
        eq(billingUsage.organizationId, orgId),
        eq(billingUsage.period, period),
      ),
    )
    .limit(1);
  return row?.postsCount ?? 0;
}

// UPDATE ... WHERE column IS NULL guarantees only one writer fires the
// dispatch per period, even when racing concurrent publish handlers.
async function markThresholdAndDispatch(
  db: DrizzleClient,
  orgId: string,
  period: string,
  column: ThresholdMark,
  ctx: {
    tier: ResolvedTier;
    quota: number;
    resetAt: Date;
    currentCount: number;
    webhookDispatcher?: WebhookDispatcher;
    eventType: "quota.warning" | "quota.exceeded";
  },
): Promise<void> {
  const updated = await db
    .update(billingUsage)
    .set({
      [column]: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(billingUsage.organizationId, orgId),
        eq(billingUsage.period, period),
        isNull(
          column === "warning80SentAt"
            ? billingUsage.warning80SentAt
            : billingUsage.exceededSentAt,
        ),
      ),
    )
    .returning();

  if (updated.length === 0) return;
  if (!ctx.webhookDispatcher) return;

  const data =
    ctx.eventType === "quota.warning"
      ? {
          period,
          postsCount: ctx.currentCount,
          quota: ctx.quota,
          percent: ctx.quota > 0 ? ctx.currentCount / ctx.quota : 1,
          resetAt: ctx.resetAt.toISOString(),
        }
      : {
          period,
          postsCount: ctx.currentCount,
          quota: ctx.quota,
          resetAt: ctx.resetAt.toISOString(),
        };

  await ctx.webhookDispatcher
    .dispatch({ organizationId: orgId, type: ctx.eventType, data })
    .catch((err: unknown) => {
      console.error("[billing] threshold webhook dispatch failed", err);
    });
}
