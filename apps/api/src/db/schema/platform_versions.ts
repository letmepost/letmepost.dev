import { pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { idColumn, timestamps } from "./_shared.js";

/**
 * Platforms letmepost.dev supports. Extend here as new platforms land. The public-facing
 * Platform enum in packages/schemas/src/platforms.ts tracks which are user-visible today
 * (Phase 1: bluesky only).
 */
export const platform = pgEnum("platform", [
  "bluesky",
  "linkedin",
  "twitter",
  "instagram",
  "facebook",
  "threads",
  "youtube",
  "tiktok",
  "pinterest",
]);

/**
 * One row per platform. `currentVersion` is the version string we pin — e.g. LinkedIn's
 * `LinkedIn-Version: 202605`. Bluesky has no versioning; store "n/a".
 */
export const platformVersions = pgTable("platform_versions", {
  id: idColumn(),
  platform: platform("platform").notNull().unique(),
  currentVersion: text("current_version").notNull(),
  notes: text("notes"),
  ...timestamps,
});

export type PlatformVersion = typeof platformVersions.$inferSelect;
export type NewPlatformVersion = typeof platformVersions.$inferInsert;
