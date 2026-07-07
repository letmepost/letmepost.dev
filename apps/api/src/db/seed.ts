import { createHash, randomBytes } from "node:crypto";
import type { DrizzleClient } from "./index.js";
import { apiKeys } from "./schema/api_keys.js";
import { member, organization, user } from "./schema/auth.js";
import { DrizzlePlatformAccountsRepository } from "../repositories/platform-accounts.js";
import { DrizzleProfilesRepository } from "../repositories/profiles.js";

export type SeedFixture = {
  organizationId: string;
  profileId: string;
  userId: string;
  apiKey: {
    id: string;
    plaintext: string;
    prefix: "lmp_live_" | "lmp_test_";
    last4: string;
  };
  accountId: string;
};

export type SeedOptions = {
  orgName?: string;
  orgSlug?: string;
  userEmail?: string;
  userName?: string;
  blueskyHandle?: string;
  blueskyAppPassword?: string;
  apiKeyPrefix?: "lmp_live_" | "lmp_test_";
};

function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Test-only seed helper. Creates one user (better-auth), one organization,
 * one membership, one API key (ours, org-scoped), and one Bluesky platform
 * account (token encrypted via the envelope module).
 */
export async function seed(
  db: DrizzleClient,
  options: SeedOptions = {},
): Promise<SeedFixture> {
  const suffix = randomBytes(4).toString("hex");
  const orgName = options.orgName ?? `seed-org-${suffix}`;
  const orgSlug = options.orgSlug ?? `seed-${suffix}`;
  const userEmail = options.userEmail ?? `seed+${suffix}@letmepost.test`;
  const userName = options.userName ?? `Seed User ${suffix}`;
  const handle = options.blueskyHandle ?? `seed-${suffix}.bsky.social`;
  const appPassword = options.blueskyAppPassword ?? `test-${suffix}-password`;
  const prefix = options.apiKeyPrefix ?? "lmp_test_";

  const [userRow] = await db
    .insert(user)
    .values({ email: userEmail, name: userName, emailVerified: true })
    .returning();
  if (!userRow) throw new Error("seed: failed to insert user");

  const [orgRow] = await db
    .insert(organization)
    .values({ name: orgName, slug: orgSlug })
    .returning();
  if (!orgRow) throw new Error("seed: failed to insert organization");

  await db.insert(member).values({
    organizationId: orgRow.id,
    userId: userRow.id,
    role: "owner",
  });

  const profileRepo = new DrizzleProfilesRepository(db);
  const profile = await profileRepo.create({
    organizationId: orgRow.id,
    name: "Default",
    slug: "default",
  });

  const rawSecret = randomBytes(24).toString("base64url");
  const plaintext = `${prefix}${rawSecret}`;
  const last4 = plaintext.slice(-4);

  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      organizationId: orgRow.id,
      name: "seed-key",
      prefix,
      hashedKey: hashApiKey(plaintext),
      last4,
      scopes: ["posts:read", "posts:write"],
    })
    .returning();
  if (!apiKey) throw new Error("seed: failed to insert api key");

  const repo = new DrizzlePlatformAccountsRepository(db);
  const account = await repo.create({
    organizationId: orgRow.id,
    profileId: profile.id,
    platform: "bluesky",
    platformAccountId: handle,
    displayName: handle,
    token: appPassword,
    tokenMetadata: { handle },
  });

  return {
    organizationId: orgRow.id,
    profileId: profile.id,
    userId: userRow.id,
    apiKey: { id: apiKey.id, plaintext, prefix, last4 },
    accountId: account.id,
  };
}
