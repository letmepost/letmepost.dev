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

type ThresholdMark = "warning_80_sent_at" | "exceeded_sent_at";

/**
 * Atomic post-quota check + increment. The single UPSERT in `tryIncrement`
 * is the load-bearing guarantee: two concurrent requests can't double-spend
 * the last slot under the cap.
 *
 * Flow:
 *   1. Resolve the org's effective tier. Infinity quota -> skip everything.
 *   2. Run the conditional UPSERT. If RETURNING is empty, the cap was hit;
 *      throw `quota_exceeded` (and emit `quota.exceeded` once per period).
 *   3. If the new count crossed 80% and we haven't yet, emit `quota.warning`
 *      and mark `warning_80_sent_at` so we don't spam.
 */
export async function checkAndIncrementQuota(
  db: DrizzleClient,
  orgId: string,
  cost: number,
  options: {
    /** Inject a webhook dispatcher so threshold events can fan out. Optional. */
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
    // Infinity quota — self_host / grandfather / enterprise. Still useful to
    // record the count so the dashboard can show usage, but we don't gate.
    const newCount = await unboundedIncrement(db, orgId, period, cost);
    return { newCount, quota, period, resetAt };
  }

  const newCount = await tryIncrement(db, orgId, period, cost, quota);

  if (newCount === null) {
    // Increment rejected — cap hit. Emit a one-shot `quota.exceeded` so the
    // org's webhook integrators see it once per period.
    await markThresholdAndDispatch(db, orgId, period, "exceeded_sent_at", {
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
    await markThresholdAndDispatch(db, orgId, period, "warning_80_sent_at", {
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

/**
 * Conditional atomic UPSERT. On conflict we add the cost only when the new
 * total stays at or under the quota. RETURNING is empty when the WHERE
 * filter rejects the update, which is how we detect "would have exceeded".
 *
 * Returns the new posts_count when the increment landed, or `null` when the
 * cap was hit.
 */
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

/**
 * Increment without the cap guard, for Infinity-quota tiers. We still write
 * so the dashboard usage view has data; just no rejection path.
 */
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

/**
 * Atomically mark the threshold column and dispatch the matching webhook
 * event. The UPDATE ... WHERE IS NULL pattern guarantees we only fire once
 * per period even when racing two concurrent publish handlers.
 */
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
          column === "warning_80_sent_at"
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
