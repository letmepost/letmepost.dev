import type { PublishResult } from "@letmepost/schemas";

/**
 * A Publisher turns a validated request into a `PublishResult` — the
 * per-platform outcome of one publish. Each platform implements this; the
 * router dispatches to the right one based on `account.platform`.
 *
 * `TContent` is intentionally generic — platforms accept richer input shapes
 * (e.g. text + media + firstComment on Bluesky).
 *
 * Note: the public response shape (`CreatePostResponse`) is now a
 * multi-target envelope assembled by the route handler from N PublishResults;
 * publishers continue to return a single platform-level result.
 */
export interface Publisher<TAccount, TContent = string> {
  publish(account: TAccount, content: TContent): Promise<PublishResult>;
}
