import { z } from "zod";

/**
 * Canonical catalog of webhook event types emitted by letmepost.dev. Keep this
 * list small and stable. Every entry is a public contract with integrators.
 * Adding an event is cheap; removing one is a breaking change.
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
export const WEBHOOK_EVENT_TYPES = [
  "post.queued",
  "post.validated",
  "post.published",
  "post.rejected",
  "post.failed",
  "post.canceled",
  "post.rescheduled",
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
