import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ensureFreshToken } from "../src/platforms/_shared/ensure-fresh-token.js";
import {
  registerProvider,
  type AccountProvider,
} from "../src/platforms/_shared/provider.js";
import { LetmepostError } from "../src/errors.js";
import { seed } from "../src/db/seed.js";
import { platformAccounts } from "../src/db/schema/platform_accounts.js";
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

afterAll(async () => {
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Stands in for a strictly-rotating provider (TikTok, and X when it chooses
 * to): the old refresh token is dead the moment it's used once.
 */
function rotatingProvider(platform: AccountProvider["platform"]) {
  const state = { valid: "refresh-0", calls: 0 };
  const provider: AccountProvider = {
    platform,
    expiringHorizonMs: 15 * 60 * 1000,
    describeConnect: () => ({ kind: "credentials", fields: [] }),
    completeConnect: async () => {
      throw new Error("not used");
    },
    async refreshToken(input) {
      state.calls++;
      const presented = (input.tokenMetadata as { refreshToken?: string } | null)
        ?.refreshToken;
      if (presented !== state.valid) {
        throw new LetmepostError({
          code: "platform_auth_failed",
          status: 401,
          platform,
          message: "refresh token already used",
        });
      }
      state.valid = `refresh-${state.calls}`;
      return {
        token: `access-${state.calls}`,
        tokenMetadata: { refreshToken: state.valid },
        tokenExpiresAt: new Date(Date.now() + 2 * HOUR_MS),
      };
    },
  };
  registerProvider(provider);
  return state;
}

describeIfDb("ensureFreshToken", () => {
  it("returns the account untouched when the token is still valid", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const state = rotatingProvider("twitter");
      const repo = new DrizzlePlatformAccountsRepository(tx);

      await tx
        .update(platformAccounts)
        .set({ platform: "twitter", tokenExpiresAt: new Date(Date.now() + 2 * HOUR_MS) })
        .where(eq(platformAccounts.id, fixture.accountId));
      const account = await repo.findById(fixture.accountId);

      await ensureFreshToken(tx, account!);
      expect(state.calls).toBe(0);
    });
  });

  it("survives losing a concurrent refresh race instead of failing the post", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      rotatingProvider("twitter");
      const repo = new DrizzlePlatformAccountsRepository(tx);

      const expired = new Date(Date.now() - HOUR_MS);
      await tx
        .update(platformAccounts)
        .set({
          platform: "twitter",
          tokenExpiresAt: expired,
          tokenMetadata: { refreshToken: "refresh-0" },
        })
        .where(eq(platformAccounts.id, fixture.accountId));
      const stale = await repo.findById(fixture.accountId);

      // Someone else refreshes first and rotates the token upstream, so the
      // snapshot we're holding is now unusable — this is exactly the state
      // the scheduled refresh worker leaves us in.
      const winner = await ensureFreshToken(tx, stale!);
      expect(winner.token).toBe("access-1");

      // Re-running against the STALE snapshot must not raise: the reload sees
      // the winner's fresh token and publishes with it.
      const loser = await ensureFreshToken(tx, stale!);
      expect(loser.token).toBe("access-1");
    });
  });

  it("still raises when the credentials are genuinely dead", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      rotatingProvider("twitter");
      const repo = new DrizzlePlatformAccountsRepository(tx);

      await tx
        .update(platformAccounts)
        .set({
          platform: "twitter",
          tokenExpiresAt: new Date(Date.now() - HOUR_MS),
          tokenMetadata: { refreshToken: "revoked-by-user" },
        })
        .where(eq(platformAccounts.id, fixture.accountId));
      const account = await repo.findById(fixture.accountId);

      await expect(ensureFreshToken(tx, account!)).rejects.toMatchObject({
        code: "platform_auth_failed",
      });
    });
  });

  it("skips credentials platforms entirely", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const state = rotatingProvider("bluesky");
      const repo = new DrizzlePlatformAccountsRepository(tx);

      await tx
        .update(platformAccounts)
        .set({
          platform: "bluesky",
          tokenExpiresAt: new Date(Date.now() - HOUR_MS),
        })
        .where(eq(platformAccounts.id, fixture.accountId));
      const account = await repo.findById(fixture.accountId);

      const result = await ensureFreshToken(tx, account!);
      expect(state.calls).toBe(0);
      expect(result.token).toBe(account!.token);
    });
  });
});
