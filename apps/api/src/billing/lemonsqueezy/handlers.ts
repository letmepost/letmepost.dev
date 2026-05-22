import { eq } from "drizzle-orm";
import type { DrizzleClient } from "../../db/index.js";
import {
  billingSubscriptions,
  type BillingSubscription,
} from "../../db/schema/billing_subscriptions.js";
import type { WebhookDispatcher } from "../../webhooks/dispatch.js";
import { invalidateOrgTier } from "../invalidate.js";
import { tierForVariant } from "./variants.js";

/**
 * Shape of the relevant subset of the Lemon Squeezy webhook payload.
 * Anything we don't read stays in the audit row's `payload` jsonb.
 */
export type LemonSqueezyPayload = {
  meta?: {
    event_name?: string;
    custom_data?: Record<string, unknown>;
  };
  data?: {
    id?: string | number;
    type?: string;
    attributes?: Record<string, unknown>;
  };
};

export type HandlerContext = {
  db: DrizzleClient;
  payload: LemonSqueezyPayload;
  webhookDispatcher?: WebhookDispatcher;
};

export type HandlerResult = {
  organizationId: string | null;
  lsSubscriptionId: string | null;
  /** Handler emitted a state mutation worth invalidating the tier cache for. */
  mutated: boolean;
};

function customDataOrgId(payload: LemonSqueezyPayload): string | null {
  const raw = payload.meta?.custom_data?.organization_id;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

function attrs(
  payload: LemonSqueezyPayload,
): Record<string, unknown> | undefined {
  return payload.data?.attributes;
}

function subscriptionId(payload: LemonSqueezyPayload): string | null {
  const id = payload.data?.id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number") return String(id);
  return null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

async function dispatchSafe(
  dispatcher: WebhookDispatcher | undefined,
  organizationId: string,
  type:
    | "subscription.activated"
    | "subscription.cancelled"
    | "subscription.tier_changed"
    | "billing.payment_failed"
    | "billing.delinquent"
    | "billing.recovered",
  data: unknown,
): Promise<void> {
  if (!dispatcher) return;
  await dispatcher
    .dispatch({ organizationId, type, data })
    .catch((err: unknown) => {
      console.error("[billing] webhook dispatch failed", type, err);
    });
}

async function loadCurrent(
  db: DrizzleClient,
  orgId: string,
): Promise<BillingSubscription | undefined> {
  const [row] = await db
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.organizationId, orgId))
    .limit(1);
  return row;
}

/**
 * UPSERT a paid subscription row keyed on organization_id. Used by both
 * `subscription_created` and `subscription_updated` since LS sometimes
 * emits the update first when a customer changes plan via the portal.
 */
export async function handleSubscriptionCreatedOrUpdated(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  const a = attrs(ctx.payload) ?? {};
  if (!orgId || !lsSubId) {
    return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: false };
  }

  const variantId = asString(a.variant_id);
  if (!variantId) {
    return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: false };
  }

  const tier = tierForVariant(variantId);
  const before = await loadCurrent(ctx.db, orgId);

  const productId = asString(a.product_id);
  const customerId = asString(a.customer_id);
  const periodStart = parseDate(a.renews_at) ?? parseDate(a.created_at);
  const periodEnd = parseDate(a.ends_at) ?? parseDate(a.renews_at);
  const cancelled = a.cancelled === true;
  const status = cancelled ? "cancelled" : "active";

  await ctx.db
    .insert(billingSubscriptions)
    .values({
      organizationId: orgId,
      tier,
      status,
      lsCustomerId: customerId,
      lsSubscriptionId: lsSubId,
      lsVariantId: variantId,
      lsProductId: productId,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: cancelled,
    })
    .onConflictDoUpdate({
      target: billingSubscriptions.organizationId,
      set: {
        tier,
        status,
        lsCustomerId: customerId,
        lsSubscriptionId: lsSubId,
        lsVariantId: variantId,
        lsProductId: productId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: cancelled,
      },
    });

  const previousTier = before?.tier ?? null;
  if (!before || before.tier === "free") {
    await dispatchSafe(ctx.webhookDispatcher, orgId, "subscription.activated", {
      tier,
      previousTier,
      periodStart: periodStart?.toISOString() ?? null,
      periodEnd: periodEnd?.toISOString() ?? null,
    });
  } else if (previousTier !== tier) {
    await dispatchSafe(
      ctx.webhookDispatcher,
      orgId,
      "subscription.tier_changed",
      {
        previousTier,
        tier,
        periodStart: periodStart?.toISOString() ?? null,
        periodEnd: periodEnd?.toISOString() ?? null,
      },
    );
  }

  return {
    organizationId: orgId,
    lsSubscriptionId: lsSubId,
    mutated: true,
  };
}

export async function handleSubscriptionCancelled(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  const a = attrs(ctx.payload) ?? {};
  if (!orgId) {
    return { organizationId: null, lsSubscriptionId: lsSubId, mutated: false };
  }
  const cancelledAt = parseDate(a.updated_at) ?? new Date();
  const periodEnd = parseDate(a.ends_at);

  const before = await loadCurrent(ctx.db, orgId);

  await ctx.db
    .update(billingSubscriptions)
    .set({
      status: "cancelled",
      cancelAtPeriodEnd: true,
      cancelledAt,
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    })
    .where(eq(billingSubscriptions.organizationId, orgId));

  await dispatchSafe(ctx.webhookDispatcher, orgId, "subscription.cancelled", {
    tier: before?.tier ?? "free",
    cancelAtPeriodEnd: true,
    cancelledAt: cancelledAt.toISOString(),
    effectiveAt: periodEnd?.toISOString() ?? null,
  });

  return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: true };
}

export async function handleSubscriptionResumed(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  if (!orgId) {
    return { organizationId: null, lsSubscriptionId: lsSubId, mutated: false };
  }
  await ctx.db
    .update(billingSubscriptions)
    .set({
      status: "active",
      cancelAtPeriodEnd: false,
      cancelledAt: null,
    })
    .where(eq(billingSubscriptions.organizationId, orgId));
  return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: true };
}

export async function handleSubscriptionExpired(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  if (!orgId) {
    return { organizationId: null, lsSubscriptionId: lsSubId, mutated: false };
  }
  await ctx.db
    .update(billingSubscriptions)
    .set({
      tier: "free",
      status: "free",
      cancelAtPeriodEnd: false,
      lsSubscriptionId: null,
      lsVariantId: null,
      lsProductId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    })
    .where(eq(billingSubscriptions.organizationId, orgId));
  return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: true };
}

export async function handleSubscriptionPaused(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  if (!orgId) {
    return { organizationId: null, lsSubscriptionId: lsSubId, mutated: false };
  }
  await ctx.db
    .update(billingSubscriptions)
    .set({ status: "paused" })
    .where(eq(billingSubscriptions.organizationId, orgId));
  return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: true };
}

export async function handleSubscriptionUnpaused(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  if (!orgId) {
    return { organizationId: null, lsSubscriptionId: lsSubId, mutated: false };
  }
  await ctx.db
    .update(billingSubscriptions)
    .set({ status: "active" })
    .where(eq(billingSubscriptions.organizationId, orgId));
  return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: true };
}

export async function handleSubscriptionPaymentSuccess(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  const a = attrs(ctx.payload) ?? {};
  if (!orgId) {
    return { organizationId: null, lsSubscriptionId: lsSubId, mutated: false };
  }

  const periodStart = parseDate(a.created_at);
  const periodEnd = parseDate(a.renews_at);
  const before = await loadCurrent(ctx.db, orgId);

  await ctx.db
    .update(billingSubscriptions)
    .set({
      status: "active",
      paymentFailedAt: null,
      ...(before?.status === "delinquent"
        ? { paymentRecoveredAt: new Date() }
        : {}),
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    })
    .where(eq(billingSubscriptions.organizationId, orgId));

  if (before?.status === "delinquent") {
    await dispatchSafe(ctx.webhookDispatcher, orgId, "billing.recovered", {
      ls_subscription_id: lsSubId,
      recoveredAt: new Date().toISOString(),
      tier: before.tier,
    });
  }

  return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: true };
}

export async function handleSubscriptionPaymentFailed(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  if (!orgId) {
    return { organizationId: null, lsSubscriptionId: lsSubId, mutated: false };
  }
  const now = new Date();
  const before = await loadCurrent(ctx.db, orgId);
  await ctx.db
    .update(billingSubscriptions)
    .set({ status: "past_due", paymentFailedAt: now })
    .where(eq(billingSubscriptions.organizationId, orgId));

  await dispatchSafe(ctx.webhookDispatcher, orgId, "billing.payment_failed", {
    ls_subscription_id: lsSubId,
    failedAt: now.toISOString(),
    tier: before?.tier ?? "free",
  });

  return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: true };
}

export async function handleSubscriptionPaymentRecovered(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const orgId = customDataOrgId(ctx.payload);
  const lsSubId = subscriptionId(ctx.payload);
  if (!orgId) {
    return { organizationId: null, lsSubscriptionId: lsSubId, mutated: false };
  }
  const now = new Date();
  const before = await loadCurrent(ctx.db, orgId);
  await ctx.db
    .update(billingSubscriptions)
    .set({
      status: "active",
      paymentRecoveredAt: now,
      paymentFailedAt: null,
    })
    .where(eq(billingSubscriptions.organizationId, orgId));

  await dispatchSafe(ctx.webhookDispatcher, orgId, "billing.recovered", {
    ls_subscription_id: lsSubId,
    recoveredAt: now.toISOString(),
    tier: before?.tier ?? "free",
  });

  return { organizationId: orgId, lsSubscriptionId: lsSubId, mutated: true };
}

/** Log-only handlers — no row mutation, just an audit trail. */
export async function handleLogOnly(
  ctx: HandlerContext,
): Promise<HandlerResult> {
  return {
    organizationId: customDataOrgId(ctx.payload),
    lsSubscriptionId: subscriptionId(ctx.payload),
    mutated: false,
  };
}

/** Single source of truth for routing event names to their handlers. */
export const EVENT_HANDLERS: Record<
  string,
  (ctx: HandlerContext) => Promise<HandlerResult>
> = {
  subscription_created: handleSubscriptionCreatedOrUpdated,
  subscription_updated: handleSubscriptionCreatedOrUpdated,
  subscription_plan_changed: handleSubscriptionCreatedOrUpdated,
  subscription_cancelled: handleSubscriptionCancelled,
  subscription_resumed: handleSubscriptionResumed,
  subscription_expired: handleSubscriptionExpired,
  subscription_paused: handleSubscriptionPaused,
  subscription_unpaused: handleSubscriptionUnpaused,
  subscription_payment_success: handleSubscriptionPaymentSuccess,
  subscription_payment_failed: handleSubscriptionPaymentFailed,
  subscription_payment_recovered: handleSubscriptionPaymentRecovered,
  subscription_payment_refunded: handleLogOnly,
  order_created: handleLogOnly,
  order_refunded: handleLogOnly,
  dispute_created: handleLogOnly,
  dispute_resolved: handleLogOnly,
};

export async function runHandlerWithCacheInvalidation(
  ctx: HandlerContext,
  handler: (ctx: HandlerContext) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const result = await handler(ctx);
  if (result.mutated && result.organizationId) {
    await invalidateOrgTier(result.organizationId);
  }
  return result;
}
