import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "./webhook-event-types.js";

/**
 * Zod surface over the webhook catalog: the event enum, the wire envelope, and
 * the per-event `data` shapes. The catalog itself lives in
 * `webhook-event-types.ts`, which is zod-free so client bundles can import it.
 *
 *   post.updated:
 *     Content of a queued post changed (caption, media, or both).
 *     `post.rescheduled` remains time-only; a request that changes both the
 *     time and the content emits both events.
 *     { id, platform, accountId, profileId,
 *       changed: Array<"text" | "media">,
 *       scheduledAt: ISO string | null,
 *       sandbox?: true }
 *
 * Billing events (subscription.*, quota.*, billing.*) carry the following
 * `data` shapes:
 *
 *   subscription.activated:
 *     { tier: "free" | "pro" | "business" | "enterprise" | "self_host",
 *       previousTier: same enum | null,
 *       periodStart: ISO string | null,
 *       periodEnd: ISO string | null }
 *
 *   subscription.cancelled:
 *     { tier: same enum, cancelAtPeriodEnd: boolean,
 *       cancelledAt: ISO string,
 *       effectiveAt: ISO string | null }
 *
 *   subscription.tier_changed:
 *     { previousTier: same enum, tier: same enum,
 *       periodStart: ISO string | null, periodEnd: ISO string | null }
 *
 *   quota.warning:
 *     { period: "YYYY-MM", postsCount: number, quota: number,
 *       percent: number (0..1), resetAt: ISO string }
 *
 *   quota.exceeded:
 *     { period: "YYYY-MM", postsCount: number, quota: number,
 *       resetAt: ISO string }
 *
 *   billing.payment_failed:
 *     { ls_subscription_id: string | null, failedAt: ISO string,
 *       tier: same enum }
 *
 *   billing.delinquent:
 *     { ls_subscription_id: string | null, since: ISO string,
 *       tier: same enum }
 *
 *   billing.recovered:
 *     { ls_subscription_id: string | null, recoveredAt: ISO string,
 *       tier: same enum }
 */
// The list itself lives in the zod-free `webhook-event-types.ts` so client
// bundles can import it via the `@letmepost/schemas/webhook-event-types`
// subpath without pulling zod in. Re-exported here so `@letmepost/schemas`
// stays the one import for server code.
export {
  WEBHOOK_EVENT_TYPES,
  isWebhookEventType,
} from "./webhook-event-types.js";

export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

/**
 * Wire envelope for every outbound webhook. The body posted to the consumer
 * endpoint is a JSON-encoded `WebhookEvent`; `data` is opaque and varies by
 * `type`. We keep the envelope stable so consumers can write one verifier.
 */
export const WebhookEvent = z.object({
  id: z.string(),
  type: WebhookEventType,
  createdAt: z.string(),
  organizationId: z.string(),
  data: z.unknown(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;
