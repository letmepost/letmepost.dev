import {
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Per-org, per-calendar-month post counter. The composite PK on
 * (organization_id, period) is what lets the atomic upsert in
 * billing/quota.ts do a single SQL round-trip per increment.
 *
 * `period` is a UTC calendar month in "YYYY-MM" form. Quota windows reset
 * on the first second of the next month.
 */
export const billingUsage = pgTable(
  "billing_usage",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    period: varchar("period", { length: 7 }).notNull(),
    postsCount: integer("posts_count").notNull().default(0),
    warning80SentAt: timestamp("warning_80_sent_at", {
      withTimezone: true,
      mode: "date",
    }),
    exceededSentAt: timestamp("exceeded_sent_at", {
      withTimezone: true,
      mode: "date",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.period] }),
  }),
);

export type BillingUsage = typeof billingUsage.$inferSelect;
export type NewBillingUsage = typeof billingUsage.$inferInsert;
