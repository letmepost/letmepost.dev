import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  EVENT_HANDLERS,
  runHandlerWithCacheInvalidation,
  type LemonSqueezyPayload,
} from "../billing/lemonsqueezy/handlers.js";
import { verifyLemonSqueezySignature } from "../billing/lemonsqueezy/signature.js";
import { billingEvents } from "../db/schema/billing_events.js";
import { LetmepostError } from "../errors.js";

export const lemonSqueezy = new Hono();

/**
 * POST /v1/lemonsqueezy/webhook
 *
 * Unauthenticated; signature-verified via HMAC-SHA256 against the raw body.
 * Every inbound event is persisted in `billing_events` so we have an audit
 * trail even for events with bad signatures. Duplicate `X-Event-Id` values
 * land as `{ ok: true, deduped: true }` and never run the handler twice.
 *
 * Handlers are idempotent against row state, so an out-of-order replay
 * (e.g. payment_success arriving after subscription_cancelled) lands as
 * a no-op rather than corrupting the row.
 */
lemonSqueezy.post("/webhook", async (c) => {
  const rawBody = await c.req.raw.clone().text();
  const signature = c.req.header("X-Signature");
  const eventName = c.req.header("X-Event-Name") ?? "";

  const secret = process.env.LMSQ_WEBHOOK_SECRET ?? "";
  if (!secret) {
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message: "LMSQ_WEBHOOK_SECRET is not configured.",
    });
  }

  // Lemon Squeezy does not send a per-event unique header. To dedupe retries
  // of the same payload, derive a stable event id from SHA-256 of the raw
  // body. Identical retries hash to the same id, distinct events hash
  // differently.
  const eventId = createHash("sha256").update(rawBody).digest("hex");

  const signatureValid = verifyLemonSqueezySignature(
    rawBody,
    signature,
    secret,
  );

  let payload: LemonSqueezyPayload | null = null;
  try {
    payload =
      rawBody.length > 0 ? (JSON.parse(rawBody) as LemonSqueezyPayload) : null;
  } catch {
    payload = null;
  }

  const orgIdFromPayload =
    typeof payload?.meta?.custom_data?.organization_id === "string"
      ? (payload.meta.custom_data.organization_id as string)
      : null;

  const inserted = await c.var.db
    .insert(billingEvents)
    .values({
      lsEventId: eventId,
      lsEventName: eventName,
      payload: payload as unknown as Record<string, unknown> | null,
      signatureValid,
      organizationId: orgIdFromPayload,
    })
    .onConflictDoNothing({ target: billingEvents.lsEventId })
    .returning();

  if (inserted.length === 0) {
    return c.json({ ok: true, deduped: true });
  }
  const rowId = inserted[0]!.id;

  if (!signatureValid) {
    return c.json({ ok: false, error: "invalid_signature" }, 400);
  }

  const handler = EVENT_HANDLERS[eventName];
  if (!handler) {
    await c.var.db
      .update(billingEvents)
      .set({
        processedAt: new Date(),
        processingError: "unhandled_event_name",
      })
      .where(eq(billingEvents.id, rowId));
    return c.json({ ok: true, handled: false });
  }

  try {
    const result = await runHandlerWithCacheInvalidation(
      {
        db: c.var.db,
        payload: payload ?? {},
        webhookDispatcher: c.var.webhookDispatcher,
      },
      handler,
    );

    await c.var.db
      .update(billingEvents)
      .set({
        processedAt: new Date(),
        ...(result.organizationId
          ? { organizationId: result.organizationId }
          : {}),
        ...(result.lsSubscriptionId
          ? { lsSubscriptionId: result.lsSubscriptionId }
          : {}),
      })
      .where(eq(billingEvents.id, rowId));

    return c.json({ ok: true, handled: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await c.var.db
      .update(billingEvents)
      .set({
        processingError: message.slice(0, 1000),
      })
      .where(eq(billingEvents.id, rowId));
    throw err;
  }
});
