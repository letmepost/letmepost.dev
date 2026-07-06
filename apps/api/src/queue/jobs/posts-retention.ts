import { and, eq, inArray, lt } from "drizzle-orm";
import { TIERS, type BillingTier } from "../../billing/tiers.js";
import type { DrizzleClient } from "../../db/index.js";
import { billingSubscriptions } from "../../db/schema/billing_subscriptions.js";
import { organization } from "../../db/schema/auth.js";
import { posts as postsTable } from "../../db/schema/posts.js";

// Statuses a post can never move out of. Retention only cleans up finished
// work — queued/validated/publishing posts are still pending (a post can be
// created long ago but scheduled to publish in the future) and must survive
// the sweep regardless of how old their createdAt is.
const TERMINAL_STATUSES = [
  "published",
  "failed",
  "rejected",
  "canceled",
] as const;

// Nightly log retention sweep. Deletes `posts` rows older than each org's
// tier-specific logRetentionDays. Infinity-retention orgs (self_host) skip
// the delete entirely. Reads tier from the row, not the cache, because this
// is a slow batch and we want the canonical value.
export async function runPostsRetention(
  db: DrizzleClient,
  options: { now?: Date } = {},
): Promise<{ orgsScanned: number; rowsDeleted: number }> {
  const now = options.now ?? new Date();

  // Pull every org with its (possibly null) subscription. Orgs with no
  // subscription row are treated as free.
  const rows = await db
    .select({
      organizationId: organization.id,
      tier: billingSubscriptions.tier,
    })
    .from(organization)
    .leftJoin(
      billingSubscriptions,
      eq(billingSubscriptions.organizationId, organization.id),
    );

  let rowsDeleted = 0;
  for (const row of rows) {
    const tier = (row.tier ?? "free") as BillingTier;
    const retentionDays = TIERS[tier].logRetentionDays;
    if (!Number.isFinite(retentionDays)) continue;
    const cutoff = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
    );

    const deleted = await db
      .delete(postsTable)
      .where(
        and(
          eq(postsTable.organizationId, row.organizationId),
          lt(postsTable.createdAt, cutoff),
          inArray(postsTable.status, TERMINAL_STATUSES),
        ),
      )
      .returning();
    rowsDeleted += deleted.length;
  }

  return { orgsScanned: rows.length, rowsDeleted };
}
