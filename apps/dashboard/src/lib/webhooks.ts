/**
 * The webhook event catalog, re-exported from the canonical list in
 * `@letmepost/schemas/webhook-event-types`.
 *
 * This used to be a hand-maintained copy, kept local to avoid pulling zod into
 * the dashboard bundle. It drifted: it was missing `post.canceled` and
 * `post.rescheduled`, both of which the scheduled-post drawer fires and
 * neither of which could be subscribed to from the webhooks page. The schemas
 * package now exposes the list through a zod-free subpath — the same split
 * `platform-state` uses — so the bundle stays clean without a second copy.
 */
export {
  WEBHOOK_EVENT_TYPES,
  isWebhookEventType,
  type WebhookEventType,
} from "@letmepost/schemas/webhook-event-types";
