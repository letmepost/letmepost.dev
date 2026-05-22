import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { idColumn, timestamps } from "./_shared.js";
import { organization } from "./auth.js";

/**
 * One row per organization. Tracks the billing tier the org is on and the
 * Lemon Squeezy state we mirror from webhooks. Free orgs get a row lazily
 * on first quota check so the tier resolver always has something to read.
 */
export const billingTier = pgEnum("billing_tier", [
  "free",
  "pro",
  "business",
  "enterprise",
  "self_host",
]);

export const billingStatus = pgEnum("billing_status", [
  "free",
  "active",
  "past_due",
  "delinquent",
  "cancelled",
  "expired",
  "paused",
]);

export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: idColumn(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    tier: billingTier("tier").notNull().default("free"),
    status: billingStatus("status").notNull().default("free"),
    lsCustomerId: text("ls_customer_id"),
    lsSubscriptionId: text("ls_subscription_id"),
    lsVariantId: text("ls_variant_id"),
    lsProductId: text("ls_product_id"),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
      mode: "date",
    }),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
      mode: "date",
    }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", {
      withTimezone: true,
      mode: "date",
    }),
    /**
     * Orgs created before BILLING_ANNOUNCED_AT get a 60-day grace window
     * where their quota is treated as Infinity. After this timestamp passes
     * the org falls back to the tier on the row (default free).
     */
    grandfatheredUntil: timestamp("grandfathered_until", {
      withTimezone: true,
      mode: "date",
    }),
    paymentFailedAt: timestamp("payment_failed_at", {
      withTimezone: true,
      mode: "date",
    }),
    paymentRecoveredAt: timestamp("payment_recovered_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (t) => ({
    orgUnique: uniqueIndex("billing_subscriptions_org_unique").on(
      t.organizationId,
    ),
    subscriptionUnique: uniqueIndex(
      "billing_subscriptions_ls_subscription_unique",
    ).on(t.lsSubscriptionId),
  }),
);

export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type NewBillingSubscription = typeof billingSubscriptions.$inferInsert;
