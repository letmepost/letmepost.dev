import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { idColumn, timestamps } from "./_shared.js";
import { user } from "./auth.js";

/**
 * One row per impersonation grant minted for the internal admin dashboard.
 *
 * Doubles as the audit log: rows are never deleted, so the table is the record
 * of who impersonated whom, when, and from where. `usedAt` is the single-use
 * guard — the consume endpoint claims a row with a conditional UPDATE, so two
 * concurrent redemptions cannot both win.
 *
 * The token itself is never stored. Only its SHA-256 lands here, so a leaked
 * database snapshot cannot be replayed into a session.
 */
export const impersonationGrants = pgTable(
  "impersonation_grants",
  {
    id: idColumn(),
    /** SHA-256 of the opaque token handed to the admin dashboard. */
    tokenHash: text("token_hash").notNull(),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Who asked. The admin dashboard authenticates with a single shared key, so
     * this is whatever operator label it sends — not a verified identity. Kept
     * as free text precisely so it can hold "shared-key" when unknown.
     */
    actor: text("actor").notNull(),
    reason: text("reason"),
    requestedIp: text("requested_ip"),
    requestedUserAgent: text("requested_user_agent"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /** Set the moment the grant is redeemed; NULL means still unused. */
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    consumedIp: text("consumed_ip"),
    /** Session minted on redemption, so it can be traced or revoked later. */
    sessionId: uuid("session_id"),
    ...timestamps,
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("impersonation_grants_token_hash_unique").on(
      t.tokenHash,
    ),
    targetIdx: index("impersonation_grants_target_idx").on(t.targetUserId),
  }),
);

export type ImpersonationGrant = typeof impersonationGrants.$inferSelect;
