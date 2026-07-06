import { randomUUID } from "node:crypto";
import type { WebhookEvent } from "@letmepost/schemas";
import { assertUrlAllowed } from "../net/guarded-fetch.js";
import { signHmac } from "./sign.js";

/**
 * Webhook delivery — the pure HTTP side. The queue wires this up with retries
 * (see `src/queue/worker.ts`); this module stays Redis-free so it can be unit
 * tested with MSW.
 *
 * ─── Retry policy: the 5xx-vs-4xx decision ──────────────────────────────────
 *
 * This is the single most-asked integrator question per the plan ("what
 * happens on a 5xx from a webhook consumer"). Our answer, codified here and
 * consumed by the worker:
 *
 *   • 2xx (status ∈ [200, 299])  → delivered. Done.
 *   • 4xx (status ∈ [400, 499])  → give up immediately. A 4xx means the
 *       consumer rejected the payload deliberately — bad signature config,
 *       missing route, auth failure. Retrying can't fix a config error and
 *       just burns quota on both sides. We surface `nonRetryable: true` so
 *       the worker doesn't re-enqueue.
 *   • 5xx (status ∈ [500, 599])  → retry with exponential backoff, up to 8
 *       attempts. After the final attempt BullMQ moves the job to its failed
 *       set — that's our DLQ for now (Redis-native, no separate queue).
 *   • Network errors (DNS, TCP, TLS, timeout) → retry, same budget as 5xx.
 *
 * Why 8 attempts at exponential(5s base)? The BullMQ default backoff doubles
 * each attempt, so the wait times are roughly 5s, 10s, 20s, 40s, 80s, 160s,
 * 320s, 640s — about 21 minutes of retries before the job lands in the DLQ.
 * That's long enough to ride out a consumer redeploy or a minor outage, short
 * enough to avoid "silent success 3 days later" footguns.
 *
 * This policy is documented verbatim in the public docs — changing it is a
 * breaking contract change. If you need a knob, add one; don't re-tune the
 * defaults in-place.
 */

export const SIGNATURE_HEADER = "X-Letmepost-Signature";
export const EVENT_HEADER = "X-Letmepost-Event";
export const EVENT_ID_HEADER = "X-Letmepost-Event-Id";
export const DELIVERY_ID_HEADER = "X-Letmepost-Delivery-Id";
export const REQUEST_ID_HEADER = "X-Letmepost-Request-Id";

/** Request timeout for a single delivery attempt. */
const DEFAULT_TIMEOUT_MS = 10_000;

export type WebhookEndpointForDelivery = {
  id: string;
  url: string;
  /** Plaintext signing secret — the caller must fetch + decrypt this. */
  signingSecret: string;
};

export type DeliveryResult = {
  ok: boolean;
  /** HTTP status code, or 0 for network / timeout errors. */
  status: number;
  durationMs: number;
  /** Truncated response body (first 2KB) — useful for dashboards + DLQ UI. */
  responseBody?: string;
  /** Unique id we attached to this attempt's headers. */
  deliveryId: string;
  /** If true, don't retry — typically a 4xx from the consumer. */
  nonRetryable?: boolean;
  /** Network-level error class (e.g. `AbortError`) when `status === 0`. */
  errorName?: string;
};

export type DeliverOptions = {
  /**
   * Inject `fetch` to keep this module testable without MSW patching globals.
   * Defaults to the platform `fetch`.
   */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Correlates the inbound request that produced this event. */
  requestId?: string;
  /** Override the generated delivery id (useful for tests / reruns). */
  deliveryId?: string;
};

/** Truncate a body so we don't persist megabytes of HTML. */
function truncate(body: string, max = 2048): string {
  return body.length <= max ? body : `${body.slice(0, max)}…[truncated]`;
}

export async function deliverWebhook(
  endpoint: WebhookEndpointForDelivery,
  event: WebhookEvent,
  options: DeliverOptions = {},
): Promise<DeliveryResult> {
  const deliveryId = options.deliveryId ?? randomUUID();
  const body = JSON.stringify(event);
  const signature = signHmac(endpoint.signingSecret, body);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [SIGNATURE_HEADER]: signature,
    [EVENT_HEADER]: event.type,
    [EVENT_ID_HEADER]: event.id,
    [DELIVERY_ID_HEADER]: deliveryId,
  };
  if (options.requestId) {
    headers[REQUEST_ID_HEADER] = options.requestId;
  }

  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  try {
    // SSRF guard: reject non-http(s) schemes and hosts that resolve to
    // internal / link-local / metadata addresses BEFORE any outbound request.
    // Throwing here lands in the catch below and reports the same failure shape
    // as a network error (status 0, errorName set) without hitting the target.
    await assertUrlAllowed(endpoint.url);

    const res = await fetchImpl(endpoint.url, {
      method: "POST",
      headers,
      body,
      // Never follow redirects: a public URL must not be able to 302 into
      // internal space. A 3xx is handled below as a non-2xx (failed) delivery.
      redirect: "manual",
      signal: controller.signal,
    });

    const responseBody = await res.text().catch(() => "");
    const durationMs = Date.now() - startedAt;

    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        status: res.status,
        durationMs,
        responseBody: truncate(responseBody),
        deliveryId,
      };
    }

    // 4xx from the consumer → permanent failure. Don't waste retries.
    if (res.status >= 400 && res.status < 500) {
      return {
        ok: false,
        status: res.status,
        durationMs,
        responseBody: truncate(responseBody),
        deliveryId,
        nonRetryable: true,
      };
    }

    // 5xx (or an unexpected 1xx/3xx that isn't a success) → retry.
    return {
      ok: false,
      status: res.status,
      durationMs,
      responseBody: truncate(responseBody),
      deliveryId,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorName = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      status: 0,
      durationMs,
      deliveryId,
      errorName,
    };
  } finally {
    clearTimeout(timer);
  }
}
