import { and, eq, lt } from "drizzle-orm";
import type { DrizzleClient } from "../../db/index.js";
import { billingSubscriptions } from "../../db/schema/billing_subscriptions.js";
import type { WebhookDispatcher } from "../../webhooks/dispatch.js";
import { invalidateOrgTier } from "../../billing/invalidate.js";

/**
 * Dunning sweep. Runs hourly. Any org whose `status='past_due'` for more
 * than 7 days flips to `delinquent`; the tier resolver caps their quota at
 * the free tier and the org gets a `billing.delinquent` webhook so
 * integrators can react (downgrade clients, send notification, etc.).
 *
 * Idempotent against row state — only matches `past_due` rows that aren't
 * already delinquent, so re-running the sweep is a no-op.
 */
export const DUNNING_GRACE_DAYS = 7;

export async function runBillingDunning(
  db: DrizzleClient,
  options: {
    now?: Date;
    webhookDispatcher?: WebhookDispatcher;
  } = {},
): Promise<{ flipped: number }> {
  const now = options.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - DUNNING_GRACE_DAYS * 24 * 60 * 60 * 1000,
  );

  const candidates = await db
    .select({
      organizationId: billingSubscriptions.organizationId,
      tier: billingSubscriptions.tier,
      lsSubscriptionId: billingSubscriptions.lsSubscriptionId,
      paymentFailedAt: billingSubscriptions.paymentFailedAt,
    })
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.status, "past_due"),
        lt(billingSubscriptions.paymentFailedAt, cutoff),
      ),
    );

  if (candidates.length === 0) return { flipped: 0 };

  let flipped = 0;
  for (const row of candidates) {
    const updated = await db
      .update(billingSubscriptions)
      .set({ status: "delinquent" })
      .where(
        and(
          eq(billingSubscriptions.organizationId, row.organizationId),
          eq(billingSubscriptions.status, "past_due"),
        ),
      )
      .returning();
    if (updated.length === 0) continue;
    flipped++;

    await invalidateOrgTier(row.organizationId);

    if (options.webhookDispatcher) {
      await options.webhookDispatcher
        .dispatch({
          organizationId: row.organizationId,
          type: "billing.delinquent",
          data: {
            ls_subscription_id: row.lsSubscriptionId,
            since: (row.paymentFailedAt ?? now).toISOString(),
            tier: row.tier,
          },
        })
        .catch((err: unknown) => {
          console.error("[dunning] dispatch failed", err);
        });
    }
  }

  return { flipped };
}
