import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Reasons a recipient address is on the suppression list. Mirrors the
// Resend webhook event taxonomy plus a manual entry for inbound mailto
// unsubscribes.
//
//   complained          — email.complained (spam button)
//   bounced_hard        — email.bounced with bounceType=permanent
//   manual_unsubscribe  — operator-entered (mailto reply, support ticket)
export const emailSuppressionReason = pgEnum("email_suppression_reason", [
  "complained",
  "bounced_hard",
  "manual_unsubscribe",
]);

// Per-recipient suppression list. Keyed on lowercased email so we don't
// store the same address twice with different casing. Hit on every
// transactional send; the read is cheap (PK lookup on text), the cost
// of skipping a bounce-prone address is a single round-trip we'd take
// anyway.
export const emailSuppressions = pgTable("email_suppressions", {
  email: text("email").primaryKey(),
  reason: emailSuppressionReason("reason").notNull(),
  // Free-form upstream id (Resend webhook event id, support ticket
  // number, etc.) for forensic backtracking. Optional.
  sourceRef: text("source_ref"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type NewEmailSuppression = typeof emailSuppressions.$inferInsert;
