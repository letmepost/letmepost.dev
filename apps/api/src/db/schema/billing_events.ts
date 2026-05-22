import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { idColumn } from "./_shared.js";
import { organization } from "./auth.js";

/**
 * Append-only audit of inbound Lemon Squeezy webhooks. Every received event
 * gets a row, even ones with bad signatures (with `signature_valid: false`
 * for the security audit trail). The unique constraint on `ls_event_id`
 * makes replay deduplication a single INSERT ... ON CONFLICT DO NOTHING.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: idColumn(),
    lsEventId: text("ls_event_id").notNull(),
    lsEventName: text("ls_event_name").notNull(),
    organizationId: uuid("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    lsSubscriptionId: text("ls_subscription_id"),
    payload: jsonb("payload"),
    signatureValid: boolean("signature_valid").notNull().default(false),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "date",
    }),
    processingError: text("processing_error"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventIdUnique: uniqueIndex("billing_events_ls_event_id_unique").on(
      t.lsEventId,
    ),
    byOrg: index("billing_events_organization_id_idx").on(t.organizationId),
    bySubscription: index("billing_events_ls_subscription_id_idx").on(
      t.lsSubscriptionId,
    ),
  }),
);

export type BillingEvent = typeof billingEvents.$inferSelect;
export type NewBillingEvent = typeof billingEvents.$inferInsert;
