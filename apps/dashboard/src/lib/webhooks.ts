/**
 * Mirror of @letmepost/schemas WEBHOOK_EVENT_TYPES. Kept local for the same
 * reason as CONNECTABLE_PLATFORMS — avoids a cross-package zod dependency in
 * the dashboard bundle. Keep both arrays in sync when the catalog changes.
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
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
