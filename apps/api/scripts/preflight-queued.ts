/**
 * Dry-run preflight over every pending post.
 *
 * The deep media checks (byte size, mime) only run at publish time, so a
 * scheduled post can sit for weeks and fail the moment it fires. This runs
 * the same checks now, against real resolved bytes, and publishes nothing.
 *
 *   pnpm tsx scripts/preflight-queued.ts [--org <organizationId>]
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/db/instance.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import { platformAccounts } from "../src/db/schema/platform_accounts.js";
import { LetmepostError } from "../src/errors.js";
import { preflightForAccount } from "../src/platforms/_shared/dispatch.js";
import { loadMediaItem } from "../src/platforms/_shared/media.js";
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import { validateTwitterMedia } from "../src/platforms/twitter/preflight.js";
import { validateBlueskyMedia } from "../src/platforms/bluesky/preflight.js";
import { validateThreadsMedia } from "../src/platforms/threads/preflight.js";
import { validateInstagramMedia } from "../src/platforms/instagram/preflight.js";
import { validateFacebookMedia } from "../src/platforms/facebook/preflight.js";

type Resolved = { kind: "image" | "video"; mimeType: string; byteLength: number; altText?: string };

const DEEP: Record<string, ((items: readonly Resolved[]) => void) | undefined> = {
  twitter: validateTwitterMedia as never,
  bluesky: validateBlueskyMedia as never,
  threads: validateThreadsMedia as never,
  instagram: validateInstagramMedia as never,
  facebook: validateFacebookMedia as never,
};

const orgArg = process.argv.indexOf("--org");
const orgId = orgArg > -1 ? process.argv[orgArg + 1] : undefined;

const rows = await db
  .select({
    id: postsTable.id,
    organizationId: postsTable.organizationId,
    accountId: postsTable.accountId,
    text: postsTable.text,
    mediaRefs: postsTable.mediaRefs,
    scheduledAt: postsTable.scheduledAt,
    platform: platformAccounts.platform,
  })
  .from(postsTable)
  .innerJoin(platformAccounts, eq(platformAccounts.id, postsTable.accountId))
  .where(
    orgId
      ? and(inArray(postsTable.status, ["queued", "validated"]), eq(postsTable.organizationId, orgId))
      : inArray(postsTable.status, ["queued", "validated"]),
  );

const repo = new DrizzlePlatformAccountsRepository(db);
let ok = 0;
const failures: Array<{ id: string; platform: string; when: string; rule: string; message: string }> = [];

for (const row of rows) {
  const when = row.scheduledAt?.toISOString() ?? "-";
  try {
    const account = await repo.findById(row.accountId!);
    if (!account) throw new LetmepostError({ code: "internal_error", status: 500, message: "account missing", rule: "account.missing" });

    const media = Array.isArray(row.mediaRefs) ? (row.mediaRefs as never[]) : [];
    preflightForAccount(account, { text: row.text, ...(media.length ? { media } : {}) });

    const deep = DEEP[row.platform];
    if (deep && media.length > 0) {
      const loaded = await Promise.all(
        media.map((m) =>
          loadMediaItem(m, {
            platform: row.platform,
            db,
            organizationId: row.organizationId,
            profileId: account.profileId,
          }),
        ),
      );
      deep(loaded.map((l) => ({ kind: l.kind, mimeType: l.mimeType, byteLength: l.byteLength, ...(l.altText !== undefined ? { altText: l.altText } : {}) })));
    }
    ok++;
  } catch (err) {
    failures.push({
      id: row.id,
      platform: row.platform,
      when,
      rule: err instanceof LetmepostError ? (err.rule ?? err.code) : "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

console.log(`\nchecked ${rows.length} pending post(s): ${ok} ok, ${failures.length} would fail\n`);
for (const f of failures) {
  console.log(`  ${f.platform.padEnd(10)} ${f.when.slice(0, 16)}  ${f.rule}`);
  console.log(`             ${f.message}`);
  console.log(`             post ${f.id}`);
}
const byRule = failures.reduce<Record<string, number>>((a, f) => ({ ...a, [f.rule]: (a[f.rule] ?? 0) + 1 }), {});
if (failures.length) console.log("\nby rule:", byRule);
process.exit(0);
