import type { DrizzleClient } from "../../db/index.js";
import { LetmepostError } from "../../errors.js";
import {
  DrizzlePlatformAccountsRepository,
  type DecryptedPlatformAccount,
} from "../../repositories/platform-accounts.js";
import { getProvider } from "./provider.js";
import { scopeKindFor } from "./scopes.js";

/**
 * How stale a token may be at publish time before we refresh it inline.
 *
 * The clock-driven refresh chain (`refresh-token` queue) is the primary
 * mechanism, but it is a chain of delayed BullMQ jobs: a Redis flush, a
 * worker outage across the wake-up, or a refresh that exhausted its three
 * attempts all break the chain silently. A scheduled post firing hours later
 * then hit the platform with a dead access token and died as a terminal
 * `rejected` — the post is gone and the user sees "authorization expired"
 * with no way to have prevented it.
 *
 * Checking expiry immediately before publishing closes that gap: the chain
 * stays the fast path, and this is the backstop that keeps a missed link from
 * costing the user a post.
 */
export const PUBLISH_REFRESH_SKEW_MS = 2 * 60 * 1000;

/**
 * Return an account whose access token is good for the next
 * {@link PUBLISH_REFRESH_SKEW_MS}, refreshing it in place if not.
 *
 * - Credentials platforms → returned untouched. Bluesky stores an app
 *   password as `token` and its publisher opens a fresh session from it on
 *   every publish, so the stored access JWT's expiry has no bearing on
 *   whether the post can go out. Refreshing here would add one to three
 *   wasted round-trips per post and buy nothing.
 * - No `tokenExpiresAt` → returned untouched; nothing to decide from.
 * - Comfortably valid → returned untouched, no upstream call.
 * - Expired / expiring → refresh via the platform's provider and persist the
 *   rotated token so concurrent and subsequent publishes see it too.
 *
 * Refresh failures are deliberately propagated rather than swallowed. The
 * caller's existing error classification then does the right thing: an auth
 * failure is terminal and tells the user to reconnect, while a transient
 * upstream failure stays retryable instead of burning the post.
 */
export async function ensureFreshToken(
  db: DrizzleClient,
  account: DecryptedPlatformAccount,
  now: Date = new Date(),
): Promise<DecryptedPlatformAccount> {
  if (scopeKindFor(account.platform) !== "oauth") return account;
  if (!account.tokenExpiresAt) return account;
  if (account.tokenExpiresAt.getTime() - now.getTime() > PUBLISH_REFRESH_SKEW_MS) {
    return account;
  }

  const provider = getProvider(account.platform);
  const refreshed = await provider.refreshToken({
    token: account.token,
    tokenMetadata: account.tokenMetadata,
  });

  const repo = new DrizzlePlatformAccountsRepository(db);
  try {
    return await repo.updateToken(account.id, {
      token: refreshed.token,
      tokenMetadata: refreshed.tokenMetadata,
      tokenExpiresAt: refreshed.tokenExpiresAt,
    });
  } catch (err) {
    // The refresh itself succeeded, so the in-memory token is publishable
    // even though we failed to persist it. Losing the write is bad (the next
    // publish refreshes again, and a rotated refresh token may now be stale)
    // but failing the post over it would be worse.
    console.error(
      `[publish] token refreshed for account ${account.id} but persisting it failed`,
      err,
    );
    return {
      ...account,
      token: refreshed.token,
      tokenMetadata: refreshed.tokenMetadata,
      tokenExpiresAt: refreshed.tokenExpiresAt,
    };
  }
}

/**
 * True when `err` means the platform will not accept this account's
 * credentials until a human reconnects.
 */
export function isAuthFailure(err: unknown): boolean {
  return err instanceof LetmepostError && err.code === "platform_auth_failed";
}
