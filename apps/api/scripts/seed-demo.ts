import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { auth } from "../src/auth.js";
import { db } from "../src/db/instance.js";
import { apiKeys } from "../src/db/schema/api_keys.js";
import {
  member,
  organization,
  session as sessionTable,
  user,
} from "../src/db/schema/auth.js";
import { posts } from "../src/db/schema/posts.js";
import { webhookEndpoints } from "../src/db/schema/webhook_endpoints.js";
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import { DrizzleProfilesRepository } from "../src/repositories/profiles.js";

/**
 * Demo seed for `testuser@gmail.com`. Creates a sign-in-able user via
 * better-auth (correct password hashing), then attaches an org with
 * profiles, platform accounts, API keys, webhooks, and a wide spread of
 * posts intended to exercise every dashboard surface:
 *
 *   - Onboarding accordion (skipped — setup is already complete)
 *   - Count cards (multiple of each)
 *   - Needs Attention card (failed posts in last 24h + tokens expiring <7d)
 *   - Recent Activity card (mixed statuses)
 *   - Post Log filters: profile / platform / status / error-code / time-range
 *   - Post detail: full error contract + raw platform response
 *   - API keys: org-wide + profile-scoped + revoked
 *   - Webhooks: active + paused, with last-delivery + last-failure-reason
 *
 * Idempotent: if the user already exists we wipe their org's data and
 * re-seed.
 *
 *   pnpm --filter @letmepost/api seed:demo
 */

const EMAIL = "testuser@gmail.com";
const PASSWORD = "password123";
const NAME = "Test User";
const ORG_NAME = "Demo Co";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generateApiKey(prefix: "lmp_live_" | "lmp_test_"): string {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}

function whSecret() {
  const plaintext = `whsec_${randomBytes(24).toString("base64url")}`;
  return {
    signingSecret: plaintext,
    secretHash: createHash("sha256").update(plaintext).digest("hex"),
  };
}

function ago(ms: number) {
  return new Date(Date.now() - ms);
}

function fromNow(ms: number) {
  return new Date(Date.now() + ms);
}

async function ensureUser(): Promise<{ id: string }> {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, EMAIL))
    .limit(1);
  if (existing) {
    console.log(`  ✓ user already exists: ${EMAIL} (id=${existing.id})`);
    return existing;
  }

  console.log(`  → creating user via better-auth: ${EMAIL}`);
  const result = await auth.api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: NAME },
  });
  if (!result || !("user" in result) || !result.user?.id) {
    throw new Error(`better-auth signUpEmail returned no user: ${JSON.stringify(result)}`);
  }
  return { id: result.user.id };
}

async function wipeUserOrgs(userId: string): Promise<void> {
  const orgs = await db
    .select({ id: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  for (const { id } of orgs) {
    await db.delete(organization).where(eq(organization.id, id));
  }
  if (orgs.length > 0) {
    console.log(`  ✓ wiped ${orgs.length} existing org(s) for user`);
  }
}

async function main() {
  console.log(`[seed-demo] seeding ${EMAIL}…`);

  const u = await ensureUser();
  await wipeUserOrgs(u.id);

  const [orgRow] = await db
    .insert(organization)
    .values({
      name: ORG_NAME,
      slug: `demo-co-${randomBytes(2).toString("hex")}`,
    })
    .returning();
  if (!orgRow) throw new Error("failed to insert organization");
  console.log(`  ✓ org: ${orgRow.name} (${orgRow.id})`);

  await db.insert(member).values({
    organizationId: orgRow.id,
    userId: u.id,
    role: "owner",
  });

  // Re-point any live sessions at the new org. Wiping the prior org dropped
  // the FK target, so existing browser sessions would get 404s on every
  // API call until the user signed out. Updating the session row here means
  // a refresh just works.
  const updatedSessions = await db
    .update(sessionTable)
    .set({ activeOrganizationId: orgRow.id })
    .where(eq(sessionTable.userId, u.id))
    .returning({ id: sessionTable.id });
  if (updatedSessions.length > 0) {
    console.log(
      `  ✓ updated ${updatedSessions.length} live session(s) → new org`,
    );
  }

  // --- Profiles -----------------------------------------------------------
  const profilesRepo = new DrizzleProfilesRepository(db);
  const defaultProfile = await profilesRepo.create({
    organizationId: orgRow.id,
    name: "Default",
    slug: "default",
  });
  const acmeProfile = await profilesRepo.create({
    organizationId: orgRow.id,
    name: "Acme Coffee",
    slug: "acme-coffee",
  });
  const sideProfile = await profilesRepo.create({
    organizationId: orgRow.id,
    name: "Side Project",
    slug: "side-project",
  });
  console.log(`  ✓ profiles: Default, Acme Coffee, Side Project`);

  // --- Platform accounts --------------------------------------------------
  // Token expiry tuning so the "Needs Attention" card has both warning rows:
  //   - linkedin expires in 3 days  → triggers
  //   - pinterest expires in 5 days → triggers
  //   - twitter   expires in 14 days → not triggered (control case)
  //   - bluesky has no expiry (app-password auth)
  const accountsRepo = new DrizzlePlatformAccountsRepository(db);

  const blueskyAccount = await accountsRepo.create({
    organizationId: orgRow.id,
    profileId: defaultProfile.id,
    platform: "bluesky",
    platformAccountId: "demo.bsky.social",
    displayName: "demo.bsky.social",
    token: "demo-app-password-not-real",
    tokenMetadata: { handle: "demo.bsky.social" },
  });
  const linkedinAccount = await accountsRepo.create({
    organizationId: orgRow.id,
    profileId: acmeProfile.id,
    platform: "linkedin",
    platformAccountId: "urn:li:person:demo123",
    displayName: "Demo Acme",
    token: "demo-linkedin-token-not-real",
    tokenMetadata: { profileUrn: "urn:li:person:demo123" },
    tokenExpiresAt: fromNow(3 * ONE_DAY_MS),
  });
  const pinterestAccount = await accountsRepo.create({
    organizationId: orgRow.id,
    profileId: acmeProfile.id,
    platform: "pinterest",
    platformAccountId: "pinterest-demo-acme",
    displayName: "@acmecoffee",
    token: "demo-pinterest-token-not-real",
    tokenMetadata: { username: "acmecoffee" },
    tokenExpiresAt: fromNow(5 * ONE_DAY_MS),
  });
  const twitterAccount = await accountsRepo.create({
    organizationId: orgRow.id,
    profileId: sideProfile.id,
    platform: "twitter",
    platformAccountId: "twitter-side-1234567890",
    displayName: "@side_project",
    token: "demo-twitter-token-not-real",
    tokenMetadata: { username: "side_project" },
    tokenExpiresAt: fromNow(14 * ONE_DAY_MS),
  });
  console.log(
    `  ✓ accounts: bluesky (Default), linkedin + pinterest (Acme — expiring), twitter (Side Project)`,
  );

  // --- API keys -----------------------------------------------------------
  // Mix of env, scope, and revoked-state so the row badges all render.
  const keySpecs: Array<{
    name: string;
    prefix: "lmp_live_" | "lmp_test_";
    profileId: string | null;
    revoked?: boolean;
  }> = [
    { name: "production-server", prefix: "lmp_live_", profileId: null },
    { name: "ci-tests", prefix: "lmp_test_", profileId: null },
    { name: "acme-only", prefix: "lmp_live_", profileId: acmeProfile.id },
    {
      name: "old-side-project-key",
      prefix: "lmp_live_",
      profileId: sideProfile.id,
      revoked: true,
    },
  ];
  for (const k of keySpecs) {
    const plaintext = generateApiKey(k.prefix);
    await db.insert(apiKeys).values({
      organizationId: orgRow.id,
      profileId: k.profileId,
      name: k.name,
      prefix: k.prefix,
      hashedKey: hashApiKey(plaintext),
      last4: plaintext.slice(-4),
      scopes: ["posts:write", "posts:read"],
      revokedAt: k.revoked ? ago(2 * ONE_DAY_MS) : null,
      lastUsedAt: k.revoked ? ago(3 * ONE_DAY_MS) : ago(15 * 60_000),
    });
  }
  console.log(`  ✓ api keys: 4 (1 live, 1 test, 1 profile-scoped, 1 revoked)`);

  // --- Webhook endpoints --------------------------------------------------
  await db.insert(webhookEndpoints).values([
    {
      organizationId: orgRow.id,
      url: "https://example.com/hooks/letmepost",
      ...whSecret(),
      eventFilter: ["post.published", "post.failed"],
      description: "Prod Slack alerter",
      active: true,
      lastDeliveryAt: ago(45 * 60_000),
    },
    {
      organizationId: orgRow.id,
      url: "https://example.com/hooks/dev",
      ...whSecret(),
      eventFilter: [],
      description: "Dev catch-all",
      active: true,
      lastDeliveryAt: ago(2 * ONE_HOUR_MS),
      lastFailureReason: "consumer returned 500: db connection refused",
    },
    {
      organizationId: orgRow.id,
      url: "https://staging.example.com/hooks",
      ...whSecret(),
      eventFilter: ["post.failed", "token.expiring"],
      description: "Staging — paused while migrating",
      active: false,
      disabledAt: ago(6 * ONE_DAY_MS),
    },
  ]);
  console.log(`  ✓ webhook endpoints: 3 (2 active, 1 paused)`);

  // --- Posts: status × platform × error code × time spread ----------------
  // Time strategy:
  //   - within last 1h    → fresh "Recent activity"
  //   - within last 24h   → drives "Needs Attention" failure count
  //   - 1–6 days ago      → seen with "Last 7 days" range filter
  //   - 8–25 days ago     → seen with "Last 30 days" range
  //   - 35+ days ago      → only with "All time" / Custom
  const postsToInsert: Parameters<typeof db.insert<typeof posts>>[0] extends never
    ? never
    : Array<typeof posts.$inferInsert> = [
    // ---------- Last hour: published ----------
    {
      organizationId: orgRow.id,
      accountId: blueskyAccount.id,
      status: "published",
      text: "shipped a thing today. the dashboard is starting to feel real.",
      publishedAt: ago(8 * 60_000),
      platformUri: "at://did:plc:demo/app.bsky.feed.post/3kfg2demo01",
      platformCid: "bafyreigdemodemo01",
      createdAt: ago(9 * 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: pinterestAccount.id,
      status: "published",
      text: "Espresso brew guide v3 — now with grind size annotations.",
      mediaRefs: [
        { url: "https://cdn.example.com/acme/espresso-v3.jpg", kind: "image" },
      ],
      publishedAt: ago(35 * 60_000),
      platformUri: "https://www.pinterest.com/pin/9000000001/",
      createdAt: ago(36 * 60_000),
    },
    // ---------- Last hour: in flight ----------
    {
      organizationId: orgRow.id,
      accountId: blueskyAccount.id,
      status: "publishing",
      text: "in flight — should be live any second",
      createdAt: ago(2 * 60_000),
    },
    // ---------- Last hour: validated, awaiting publish ----------
    {
      organizationId: orgRow.id,
      accountId: linkedinAccount.id,
      status: "validated",
      text: "Preflight passed; queued for the LinkedIn worker.",
      scheduledAt: fromNow(15 * 60_000),
      createdAt: ago(3 * 60_000),
    },
    // ---------- Future: queued ----------
    {
      organizationId: orgRow.id,
      accountId: blueskyAccount.id,
      status: "queued",
      text: "Scheduled for tomorrow morning.",
      scheduledAt: fromNow(20 * ONE_HOUR_MS),
      createdAt: ago(5 * 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: twitterAccount.id,
      status: "queued",
      text: "/v1 launch teaser — go live with the blog post.",
      scheduledAt: fromNow(3 * ONE_DAY_MS),
      createdAt: ago(45 * 60_000),
    },
    // ---------- Last 24h: failures (drive Needs Attention) ----------
    {
      organizationId: orgRow.id,
      accountId: linkedinAccount.id,
      status: "failed",
      text: "This LinkedIn post is way over the 3,000-grapheme limit. ".repeat(120),
      error: {
        code: "preflight_failed",
        rule: "linkedin.text.grapheme_count",
        platform: "linkedin",
        platformVersion: "202504",
        message: "LinkedIn rejects posts longer than 3,000 graphemes; this draft is 6,840.",
        remediation:
          "Trim the body or split across multiple posts. Counting uses Intl.Segmenter so emoji + ZWJ count as 1.",
      },
      createdAt: ago(20 * 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: blueskyAccount.id,
      status: "failed",
      text: "Image attached — but the URL isn't reachable.",
      error: {
        code: "preflight_failed",
        rule: "media.url.reachable",
        platform: "bluesky",
        message: "Media URL returned 403 on HEAD request; Bluesky's blob upload would fail.",
        platformResponse: {
          url: "https://drive.google.com/file/d/abc/view",
          status: 403,
        },
        remediation:
          "Host the asset on a publicly reachable CDN (R2, S3 with public read, etc.) and retry.",
      },
      createdAt: ago(2 * ONE_HOUR_MS),
    },
    {
      organizationId: orgRow.id,
      accountId: twitterAccount.id,
      status: "failed",
      text: "first post from the new dev environment 🎉",
      error: {
        code: "platform_auth_failed",
        rule: "twitter.token.invalid",
        platform: "twitter",
        platformVersion: "v2",
        message: "Twitter rejected the token: 401 Unauthorized.",
        platformResponse: {
          status: 401,
          body: { title: "Unauthorized", type: "about:blank", status: 401 },
        },
        remediation: "Reconnect the Twitter account from /accounts to refresh the token.",
      },
      createdAt: ago(5 * ONE_HOUR_MS),
    },
    {
      organizationId: orgRow.id,
      accountId: linkedinAccount.id,
      status: "rejected",
      text: "duplicate post body that was sent twice within the dedup window",
      error: {
        code: "platform_rejected",
        rule: "linkedin.duplicate",
        platform: "linkedin",
        platformVersion: "202504",
        message: "LinkedIn rejected the post: duplicate of a recent post.",
        platformResponse: {
          status: 422,
          body: { code: "DUPLICATE_POST", message: "Duplicate share detected." },
        },
        remediation:
          "LinkedIn dedupes identical content within ~24h. Wait, edit the text, or post from a different account.",
      },
      createdAt: ago(8 * ONE_HOUR_MS),
    },

    // ---------- Last 7 days: more published + a couple of failures ---------
    {
      organizationId: orgRow.id,
      accountId: linkedinAccount.id,
      status: "published",
      text: "We just open-sourced our publishing layer. Failures are loud, preventable, documented. → letmepost.dev",
      publishedAt: ago(2 * ONE_DAY_MS),
      platformUri: "urn:li:share:7000000000000000001",
      createdAt: ago(2 * ONE_DAY_MS + 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: blueskyAccount.id,
      status: "published",
      text: "Honest commit messages > performative ones.",
      publishedAt: ago(2 * ONE_DAY_MS + 4 * ONE_HOUR_MS),
      platformUri: "at://did:plc:demo/app.bsky.feed.post/3kfg2demo02",
      platformCid: "bafyreigdemodemo02",
      createdAt: ago(2 * ONE_DAY_MS + 4 * ONE_HOUR_MS + 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: pinterestAccount.id,
      status: "published",
      text: "Cold brew ratios — tested across 8 beans.",
      mediaRefs: [
        { url: "https://cdn.example.com/acme/cold-brew-ratios.jpg", kind: "image" },
      ],
      publishedAt: ago(3 * ONE_DAY_MS),
      platformUri: "https://www.pinterest.com/pin/9000000002/",
      createdAt: ago(3 * ONE_DAY_MS + 30_000),
    },
    {
      organizationId: orgRow.id,
      accountId: twitterAccount.id,
      status: "published",
      text: "Spent the morning ripping out 2k lines of useEffect. 🪦",
      publishedAt: ago(4 * ONE_DAY_MS),
      platformUri: "https://twitter.com/side_project/status/1900000000000000001",
      createdAt: ago(4 * ONE_DAY_MS + 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: linkedinAccount.id,
      status: "failed",
      text: "Quarterly product update — 3-image carousel.",
      mediaRefs: [
        { url: "https://cdn.example.com/q1-1.jpg", kind: "image" },
        { url: "https://cdn.example.com/q1-2.jpg", kind: "image" },
        { url: "https://cdn.example.com/q1-3.jpg", kind: "image" },
      ],
      error: {
        code: "validation_failed",
        rule: "linkedin.media.aspect_ratio",
        platform: "linkedin",
        message: "Image 2 has aspect ratio 0.46; LinkedIn requires 0.5–2.0.",
        platformResponse: {
          field: "media[1].aspectRatio",
          value: 0.46,
          allowed: [0.5, 2.0],
        },
        remediation:
          "Crop image 2 to a portrait aspect ratio of 0.5 or wider before posting.",
      },
      createdAt: ago(5 * ONE_DAY_MS),
    },
    {
      organizationId: orgRow.id,
      accountId: pinterestAccount.id,
      status: "failed",
      text: "Pinterest hiccup mid-publish.",
      error: {
        code: "platform_unavailable",
        rule: "pinterest.5xx",
        platform: "pinterest",
        message: "Pinterest API returned 503 Service Unavailable on board lookup.",
        platformResponse: {
          status: 503,
          body: { code: 503, message: "service temporarily unavailable" },
        },
        remediation:
          "Pinterest occasionally has multi-minute outages. We retried 8x — give it 5 minutes and re-publish.",
      },
      createdAt: ago(5 * ONE_DAY_MS + 6 * ONE_HOUR_MS),
    },

    // ---------- 8–25 days ago: a healthy spread ---------------------------
    {
      organizationId: orgRow.id,
      accountId: blueskyAccount.id,
      status: "published",
      text: "Tooling > talent. Build the workshop, not the artifact.",
      publishedAt: ago(10 * ONE_DAY_MS),
      platformUri: "at://did:plc:demo/app.bsky.feed.post/3kfg2demo03",
      platformCid: "bafyreigdemodemo03",
      createdAt: ago(10 * ONE_DAY_MS + 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: linkedinAccount.id,
      status: "published",
      text: "Reflection: 90 days into letmepost, the wedge that's working is transparent errors — not flat pricing.",
      publishedAt: ago(12 * ONE_DAY_MS),
      platformUri: "urn:li:share:7000000000000000002",
      createdAt: ago(12 * ONE_DAY_MS + 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: twitterAccount.id,
      status: "published",
      text: "Refactor: AccountProvider now describes credentials *and* OAuth descriptors uniformly. Felt good.",
      publishedAt: ago(14 * ONE_DAY_MS),
      platformUri: "https://twitter.com/side_project/status/1900000000000000002",
      createdAt: ago(14 * ONE_DAY_MS + 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: pinterestAccount.id,
      status: "published",
      text: "Bean origin map — Yemen, Ethiopia, Honduras side-by-side.",
      mediaRefs: [
        { url: "https://cdn.example.com/acme/origin-map.jpg", kind: "image" },
      ],
      publishedAt: ago(18 * ONE_DAY_MS),
      platformUri: "https://www.pinterest.com/pin/9000000003/",
      createdAt: ago(18 * ONE_DAY_MS + 60_000),
    },
    {
      organizationId: orgRow.id,
      accountId: blueskyAccount.id,
      status: "failed",
      text: "Late-night attempt that hit a transient encoding bug.",
      error: {
        code: "internal_error",
        rule: "publisher.encoding.utf16_surrogate",
        platform: "bluesky",
        message:
          "Internal: lone-surrogate code unit detected in `text`; AT-Proto requires well-formed UTF-16.",
        remediation:
          "We've patched the publisher to scrub surrogates pre-flight. Re-run the post; if it fails again, ping us.",
      },
      createdAt: ago(20 * ONE_DAY_MS),
    },
    {
      organizationId: orgRow.id,
      accountId: twitterAccount.id,
      status: "rejected",
      text: "Same tweet, different day. (a duplicate)",
      error: {
        code: "platform_rejected",
        rule: "twitter.duplicate",
        platform: "twitter",
        platformVersion: "v2",
        message: "Twitter rejected the tweet: duplicate within the last 24h window.",
        platformResponse: {
          status: 403,
          body: {
            errors: [
              { code: 187, message: "Status is a duplicate." },
            ],
          },
        },
        remediation:
          "Edit the text and retry. Twitter's dedupe window is rolling; an exact match within ~24h is rejected.",
      },
      createdAt: ago(22 * ONE_DAY_MS),
    },

    // ---------- 35+ days ago: only visible on All time / Custom -----------
    {
      organizationId: orgRow.id,
      accountId: linkedinAccount.id,
      status: "published",
      text: "Out-of-range post for testing the time filter — only shows on All time.",
      publishedAt: ago(38 * ONE_DAY_MS),
      platformUri: "urn:li:share:7000000000000000099",
      createdAt: ago(38 * ONE_DAY_MS + 60_000),
    },
  ];

  await db.insert(posts).values(postsToInsert);
  console.log(`  ✓ posts: ${postsToInsert.length} across all 4 platforms, all 6 statuses, all 6 error codes, time-spread 0–38 days`);

  console.log(`
[seed-demo] done. sign in as:
  email:    ${EMAIL}
  password: ${PASSWORD}
  org:      ${orgRow.name}

Surfaces exercised:
  · Sidebar — 3 profiles (Default / Acme Coffee / Side Project)
  · Needs Attention — failed posts in last 24h + 2 expiring tokens (linkedin 3d, pinterest 5d)
  · Recent Activity — mixed published / publishing / failed in last hour
  · Post Log — 4 platforms × 6 statuses × 6 error codes, spread 0–38d
  · API Keys — live + test + profile-scoped + revoked
  · Webhooks — 2 active (one with last-failure-reason) + 1 paused
`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
