/**
 * Canonical catalog of webhook event types emitted by letmepost.dev. Keep this
 * list small and stable. Every entry is a public contract with integrators.
 * Adding an event is cheap; removing one is a breaking change.
 *
 * This module is intentionally zod-free so it can be imported by client
 * bundles (dashboard, marketing site) via the `@letmepost/schemas/webhook-event-types`
 * subpath without pulling zod into the runtime — the same reason
 * `platform-state.ts` is split out.
 *
 * It exists because the catalog used to live in three places: this package,
 * `apps/dashboard/src/lib/webhooks.ts`, and a separate hand-written union in
 * `apps/dashboard/src/lib/analytics.ts`. The dashboard copies drifted and were
 * missing `post.canceled` and `post.rescheduled` — events the scheduled-post
 * drawer itself fires, that nobody could subscribe to from the dashboard.
 * The zod envelope and payload documentation live in `webhook-events.ts`,
 * which builds on this list.
 */
export const WEBHOOK_EVENT_TYPES = [
  "post.queued",
  "post.validated",
  "post.published",
  "post.rejected",
  "post.failed",
  "post.canceled",
  "post.rescheduled",
  "post.updated",
  "token.expiring",
  "token.revoked",
  "version.deprecated",
  "subscription.activated",
  "subscription.cancelled",
  "subscription.tier_changed",
  "quota.warning",
  "quota.exceeded",
  "billing.payment_failed",
  "billing.delinquent",
  "billing.recovered",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(v: unknown): v is WebhookEventType {
  return (
    typeof v === "string" &&
    (WEBHOOK_EVENT_TYPES as readonly string[]).includes(v)
  );
}
