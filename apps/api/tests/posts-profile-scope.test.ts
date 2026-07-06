import { createHash, randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { apiKeys } from "../src/db/schema/api_keys.js";
import { seed } from "../src/db/seed.js";
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import { DrizzleProfilesRepository } from "../src/repositories/profiles.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

function blueskyHappyHandlers() {
  return [
    http.post(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      () =>
        HttpResponse.json({
          accessJwt: "access",
          refreshJwt: "refresh",
          did: "did:plc:test",
          handle: "alice.bsky.social",
        }),
    ),
    http.post(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      () =>
        HttpResponse.json({
          uri: "at://did:plc:test/app.bsky.feed.post/abcxyz",
          cid: "bafy-mock",
        }),
    ),
  ];
}

/**
 * Mint a profile-scoped API key for `seedFixture.organizationId`. Returns
 * the plaintext + the new account it owns under the new profile.
 */
async function mintProfileScopedKey(
  tx: Awaited<ReturnType<typeof getTestDb>>["db"],
  fixture: Awaited<ReturnType<typeof seed>>,
  profileSlug: string,
) {
  const profileRepo = new DrizzleProfilesRepository(tx);
  const profile = await profileRepo.create({
    organizationId: fixture.organizationId,
    name: profileSlug,
    slug: profileSlug,
  });

  const accountRepo = new DrizzlePlatformAccountsRepository(tx);
  const handle = `${profileSlug}.bsky.social`;
  const account = await accountRepo.create({
    organizationId: fixture.organizationId,
    profileId: profile.id,
    platform: "bluesky",
    platformAccountId: handle,
    displayName: handle,
    token: `app-pw-${profileSlug}`,
  });

  const rawSecret = randomBytes(24).toString("base64url");
  const plaintext = `lmp_test_${rawSecret}`;
  const last4 = plaintext.slice(-4);
  const [key] = await tx
    .insert(apiKeys)
    .values({
      organizationId: fixture.organizationId,
      profileId: profile.id,
      name: `key-${profileSlug}`,
      prefix: "lmp_test_",
      hashedKey: createHash("sha256").update(plaintext).digest("hex"),
      last4,
      scopes: ["posts:write"],
    })
    .returning();
  if (!key) throw new Error("failed to insert api key");

  return { profile, account, plaintext };
}

describeIfDb("API key profile scope (POST /v1/posts)", () => {
  it("org-wide key (NULL profile) can publish to any profile's account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx); // org-wide key
      const { account: scopedAccount } = await mintProfileScopedKey(
        tx,
        fixture,
        "client-a",
      );
      server.use(...blueskyHappyHandlers());

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: scopedAccount.id }],
          text: "hello from org-wide key",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ accountId: string; status: string }>;
      };
      expect(body.status).toBe("published");
      expect(body.results[0]!.accountId).toBe(scopedAccount.id);
      expect(body.results[0]!.status).toBe("published");
    });
  });

  it("profile-scoped key publishes to its own profile's account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { account, plaintext } = await mintProfileScopedKey(
        tx,
        fixture,
        "scoped",
      );
      server.use(...blueskyHappyHandlers());

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: account.id }],
          text: "hello from scoped key",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ accountId: string; status: string }>;
      };
      expect(body.status).toBe("published");
      expect(body.results[0]!.accountId).toBe(account.id);
      expect(body.results[0]!.status).toBe("published");
    });
  });

  it("profile-scoped key 404s on an account in a different profile (no leak)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { plaintext } = await mintProfileScopedKey(tx, fixture, "client-a");
      const { account: otherAccount } = await mintProfileScopedKey(
        tx,
        fixture,
        "client-b",
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: otherAccount.id }],
          text: "should be denied",
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("api_key.profile_scope");
    });
  });

  it("post.published payload carries profileId for downstream filtering", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(...blueskyHappyHandlers());

      const captured: Array<{ type: string; data: Record<string, unknown> }> = [];
      const app = createApp({
        db: tx,
        webhookDispatcher: {
          async dispatch(ev) {
            captured.push({
              type: ev.type,
              data: ev.data as Record<string, unknown>,
            });
          },
        },
      });

      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "for the webhook",
        }),
      });
      expect(res.status).toBe(200);

      const published = captured.find((e) => e.type === "post.published");
      expect(published).toBeDefined();
      expect(published!.data.profileId).toBe(fixture.profileId);
    });
  });

  it("revoking the key still works through the scope check (revoked → 401)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { account, plaintext } = await mintProfileScopedKey(
        tx,
        fixture,
        "revoke-me",
      );
      // revoke the key
      await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          eq(
            apiKeys.hashedKey,
            createHash("sha256").update(plaintext).digest("hex"),
          ),
        );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: account.id }],
          text: "post-revoke",
        }),
      });
      expect(res.status).toBe(401);
    });
  });
});
