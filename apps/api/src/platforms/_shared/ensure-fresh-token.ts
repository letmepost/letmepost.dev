import type { DrizzleClient } from "../../db/index.js";
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
 * This is a best-effort backstop, so it NEVER fails the publish. A refresh
 * that can't run — no provider registered for the platform, a legacy row whose
 * stored credential the provider doesn't understand (Meta-provisioned
 * instagram rows carry a Page token), or a rotation race lost to the scheduled
 * worker — falls through to publishing with the existing token. Raising here
 * would turn a publish that previously worked into a terminal rejection; if
 * the credential really is dead, the publish itself reports that honestly.
 *
 * Concurrency: this and the scheduled refresh worker can target one account at
 * once, and strictly-rotating providers kill the old refresh token on first
 * use. Re-read the row instead of trusting the caller's snapshot, persist
 * under a compare-and-swap so only one coherent pair lands, and re-read once
 * more on failure to pick up a concurrent winner's token.
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

  let refreshed;
  try {
    // getProvider throws for an unregistered platform — that must not be the
    // thing that kills the post.
    const provider = getProvider(current.platform);
    refreshed = await provider.refreshToken({
      token: current.token,
      tokenMetadata: current.tokenMetadata,
    });
  } catch (err) {
    // Someone else may have just succeeded; prefer their token.
    const reloaded = await repo.findById(account.id);
    if (reloaded && isFresh(reloaded, now)) return reloaded;
    console.warn(
      `[publish] inline token refresh failed for account ${account.id}; publishing with the existing token`,
      err,
    );
    return current;
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
