import { and, eq, lt } from "drizzle-orm";
import { TIERS, type BillingTier } from "../../billing/tiers.js";
import type { DrizzleClient } from "../../db/index.js";
import { billingSubscriptions } from "../../db/schema/billing_subscriptions.js";
import { organization } from "../../db/schema/auth.js";
import { posts as postsTable } from "../../db/schema/posts.js";

/**
 * Log retention sweep. Runs nightly. For every org, deletes `posts` rows
 * older than that org's tier's logRetentionDays. Infinity retention orgs
 * (self_host, enterprise) skip the delete entirely.
 *
 * Reads tier from the row directly. The cache doesn't matter here — this
 * is a slow batch and we want the canonical value.
 */
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
        ),
      )
      .returning();
    rowsDeleted += deleted.length;
  }

  return { orgsScanned: rows.length, rowsDeleted };
}
