import type { DrizzleClient } from "../../db/index.js";
import { LetmepostError } from "../../errors.js";
import {
  DrizzlePlatformAccountsRepository,
  type DecryptedPlatformAccount,
} from "../../repositories/platform-accounts.js";
import { getProvider } from "./provider.js";
import { scopeKindFor } from "./scopes.js";

/**
 * How stale a token may be at publish time before we refresh it inline. The
 * clock-driven `refresh-token` queue is the primary mechanism, but it's a
 * chain of delayed jobs — a Redis flush or a worker outage breaks it silently,
 * and a post scheduled hours out then fires with a dead token.
 */
export const PUBLISH_REFRESH_SKEW_MS = 2 * 60 * 1000;

function isFresh(account: DecryptedPlatformAccount, now: Date): boolean {
  if (!account.tokenExpiresAt) return true;
  return account.tokenExpiresAt.getTime() - now.getTime() > PUBLISH_REFRESH_SKEW_MS;
}

/**
 * Return an account whose access token is good for the next
 * {@link PUBLISH_REFRESH_SKEW_MS}, refreshing it in place if not.
 *
 * Credentials platforms are skipped: Bluesky stores an app password and its
 * publisher opens a fresh session per publish, so the stored JWT's expiry says
 * nothing about deliverability and refreshing would just burn round-trips.
 *
 * Concurrency: this and the scheduled refresh worker can target one account at
 * once, and strictly-rotating providers (TikTok, X when it chooses to) kill the
 * old refresh token on first use — so the loser gets `platform_auth_failed` and
 * its post is terminally rejected. Three things prevent that: re-read the row
 * instead of trusting the caller's snapshot, persist under a compare-and-swap
 * so only one coherent pair lands, and re-read once more on failure to pick up
 * a concurrent winner's token rather than raising.
 */
export async function ensureFreshToken(
  db: DrizzleClient,
  account: DecryptedPlatformAccount,
  now: Date = new Date(),
): Promise<DecryptedPlatformAccount> {
  if (scopeKindFor(account.platform) !== "oauth") return account;
  if (isFresh(account, now)) return account;

  const repo = new DrizzlePlatformAccountsRepository(db);

  // The caller's snapshot may predate a refresh that already landed.
  const current = (await repo.findById(account.id)) ?? account;
  if (isFresh(current, now)) return current;

  const provider = getProvider(current.platform);
  let refreshed;
  try {
    refreshed = await provider.refreshToken({
      token: current.token,
      tokenMetadata: current.tokenMetadata,
    });
  } catch (err) {
    if (err instanceof LetmepostError && err.code === "platform_auth_failed") {
      const reloaded = await repo.findById(account.id);
      if (reloaded && isFresh(reloaded, now)) return reloaded;
    }
    throw err;
  }

  const persisted = await repo.casUpdateToken(
    current.id,
    {
      token: refreshed.token,
      tokenMetadata: refreshed.tokenMetadata,
      tokenExpiresAt: refreshed.tokenExpiresAt,
    },
    current.tokenExpiresAt,
  );
  if (persisted) return persisted;

  // Lost the CAS. Prefer whatever the winner stored — ours may already be
  // superseded upstream by their rotation.
  const winner = await repo.findById(account.id);
  if (winner && isFresh(winner, now)) return winner;

  // No winner visible (transient read, or the write raced elsewhere). The
  // refresh succeeded, so publish with it rather than failing the post.
  return {
    ...current,
    token: refreshed.token,
    tokenMetadata: refreshed.tokenMetadata,
    tokenExpiresAt: refreshed.tokenExpiresAt,
  };
}
