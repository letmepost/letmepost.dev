import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { idColumn, timestamps } from "./_shared.js";
import { organization } from "./auth.js";
import { platformAccounts } from "./platform_accounts.js";

export const postStatus = pgEnum("post_status", [
  "queued",
  "validated",
  "publishing",
  "published",
  "failed",
  "rejected",
  "canceled",
]);

export const posts = pgTable(
  "posts",
  {
    id: idColumn(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => platformAccounts.id, {
      onDelete: "set null",
    }),
    status: postStatus("status").notNull().default("queued"),
    text: text("text").notNull(),
    mediaRefs: jsonb("media_refs").$type<unknown[]>().notNull().default([]),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    platformUri: text("platform_uri"),
    platformCid: text("platform_cid"),
    /** Canonical error contract snapshot when status is failed/rejected. */
    error: jsonb("error").$type<Record<string, unknown>>(),
    /**
     * Written by an `lmp_test_` key. The worker reads this off the row (it has
     * no API-key context), so it is the authority on whether a scheduled post
     * may touch a platform.
     */
    sandbox: boolean("sandbox").notNull().default(false),
    ...timestamps,
  },
  (t) => ({
    byOrgCreated: index("posts_organization_created_at_idx").on(
      t.organizationId,
      t.createdAt,
    ),
    byAccount: index("posts_account_id_idx").on(t.accountId),
    byStatus: index("posts_status_idx").on(t.status),
  }),
);

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
