/**
 * HMAC-SHA256 verification for letmepost.dev webhook deliveries.
 *
 * Wire shape, identical to GitHub / Stripe: the `X-Letmepost-Signature`
 * header is `sha256=<hex>` over the raw request body, signed with the
 * endpoint's `signingSecret`. Bare hex (no prefix) is also accepted so
 * proxies that strip prefixes don't break verification.
 *
 * The headers the API ships on every delivery, for reference:
 *   X-Letmepost-Signature   sha256=<hex>
 *   X-Letmepost-Event       e.g. post.published
 *   X-Letmepost-Event-Id    stable event id (idempotent on the consumer)
 *   X-Letmepost-Delivery-Id unique per attempt
 *
 * No timestamp tolerance: the API does not include a timestamp in the
 * signature, so replay defense is handled by deduping on the event id at
 * the consumer.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

export interface VerifyWebhookArgs {
  /** Raw request body bytes as received, before any JSON parsing. */
  body: string | Uint8Array;
  /** Value of the `X-Letmepost-Signature` header. */
  signature: string | undefined | null;
  /** The endpoint's signing secret. Returned once at endpoint creation. */
  secret: string;
}

/**
 * Verify a webhook signature and return the parsed event. Throws on any
 * verification failure, malformed JSON, or missing signature, never returning
 * a partially trusted payload.
 */
export function verifyWebhook<T = unknown>(args: VerifyWebhookArgs): T {
  if (!verifyWebhookSignature(args)) {
    throw new Error("letmepost webhook signature verification failed");
  }
  const text = typeof args.body === "string" ? args.body : new TextDecoder().decode(args.body);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`letmepost webhook body was not valid JSON: ${detail}`);
  }
}

/**
 * Lower-level: returns a boolean instead of throwing, and does not parse
 * JSON. Use when you want to log a verification failure without crashing
 * the handler.
 */
export function verifyWebhookSignature(args: VerifyWebhookArgs): boolean {
  if (typeof args.signature !== "string" || args.signature.length === 0) return false;
  if (typeof args.secret !== "string" || args.secret.length === 0) return false;

  const bodyBytes =
    typeof args.body === "string" ? Buffer.from(args.body, "utf8") : Buffer.from(args.body);
  const digest = createHmac("sha256", args.secret).update(bodyBytes).digest("hex");
  const expected = `${PREFIX}${digest}`;
  const presented = args.signature.startsWith(PREFIX)
    ? args.signature
    : `${PREFIX}${args.signature}`;

  if (expected.length !== presented.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const SIGNATURE_HEADER = "X-Letmepost-Signature";
export const EVENT_HEADER = "X-Letmepost-Event";
export const EVENT_ID_HEADER = "X-Letmepost-Event-Id";
export const DELIVERY_ID_HEADER = "X-Letmepost-Delivery-Id";

export type WebhookEventType =
  | "post.queued"
  | "post.validated"
  | "post.published"
  | "post.rejected"
  | "post.failed"
  | "token.expiring"
  | "token.revoked"
  | "version.deprecated";

export interface WebhookEvent<TData = unknown> {
  id: string;
  type: WebhookEventType | string;
  createdAt: string;
  data: TData;
}
