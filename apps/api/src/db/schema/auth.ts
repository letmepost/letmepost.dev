import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { idColumn, timestamps } from "./_shared.js";

/* -------------------------------------------------------------------------- */
/* better-auth core tables                                                    */
/* -------------------------------------------------------------------------- */

export const user = pgTable(
  "user",
  {
    id: idColumn(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // First-touch attribution. Captured on landing in apps/web, propagated
    // to dashboard.letmepost.dev via query params, and persisted here by
    // better-auth's `user.additionalFields` on signup. Null for users who
    // signed up before this shipped or arrived without any attribution
    // signal. signupSource is the derived high-level bucket
    // ("producthunt", "hackernews", "google", "direct", ...); the raw
    // utm_* and referrer fields are kept for re-derivation.
    signupSource: text("signup_source"),
    signupUtmSource: text("signup_utm_source"),
    signupUtmMedium: text("signup_utm_medium"),
    signupUtmCampaign: text("signup_utm_campaign"),
    signupUtmContent: text("signup_utm_content"),
    signupUtmTerm: text("signup_utm_term"),
    signupReferrer: text("signup_referrer"),
    signupLandingPath: text("signup_landing_path"),
    ...timestamps,
  },
  (t) => ({
    emailUnique: uniqueIndex("user_email_unique").on(t.email),
  }),
);

export const session = pgTable(
  "session",
  {
    id: idColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Populated by the organizations plugin when a user switches active org. */
    activeOrganizationId: uuid("active_organization_id"),
    /**
     * Non-null marks this session as an admin impersonation, holding the actor
     * label from the grant. The dashboard reads it to show the "viewing as"
     * banner; a normal sign-in always leaves it NULL.
     */
    impersonatedBy: text("impersonated_by"),
    ...timestamps,
  },
  (t) => ({
    tokenUnique: uniqueIndex("session_token_unique").on(t.token),
  }),
);

/**
 * better-auth's OAuth provider account table. NOT the same as our
 * platform_accounts (connected Bluesky/LinkedIn/etc. for publishing). This
 * stores the user's Google/GitHub identity for signing in to the dashboard.
 */
export const account = pgTable("account", {
  id: idColumn(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Provider's own id for this account (Google sub, GitHub numeric id, …). */
  accountId: text("account_id").notNull(),
  /** "google" | "github" — which provider this identity came from. */
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  scope: text("scope"),
  /** Unused — we disable email/password. Column kept for better-auth compat. */
  password: text("password"),
  ...timestamps,
});

export const verification = pgTable("verification", {
  id: idColumn(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  ...timestamps,
});

/* -------------------------------------------------------------------------- */
/* better-auth organization plugin tables                                     */
/* -------------------------------------------------------------------------- */

export const organization = pgTable(
  "organization",
  {
    id: idColumn(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    /** JSON string, as better-auth stores org metadata. */
    metadata: text("metadata"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("organization_slug_unique").on(t.slug),
  }),
);

export const member = pgTable(
  "member",
  {
    id: idColumn(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** "owner" | "admin" | "member" — better-auth uses text, not enum. */
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqMembership: uniqueIndex("member_org_user_unique").on(
      t.organizationId,
      t.userId,
    ),
  }),
);

export const invitation = pgTable("invitation", {
  id: idColumn(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  /** "pending" | "accepted" | "rejected" | "canceled". */
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  inviterId: uuid("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Organization = typeof organization.$inferSelect;
export type Member = typeof member.$inferSelect;
export type Invitation = typeof invitation.$inferSelect;
