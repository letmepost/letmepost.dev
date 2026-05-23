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

// POST /v1/lemonsqueezy/webhook
//
// Unauthenticated, signature-verified via HMAC-SHA256 against the raw body.
// Lemon Squeezy does not send a per-event unique header, so dedupe is keyed
// on SHA-256 of the raw body: identical retries collapse, distinct events
// stay distinct.
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

  // Verify the signature BEFORE touching the DB. Bad-sig requests get dropped
  // cheap so an attacker cannot fill billing_events with unique payloads.
  if (!verifyLemonSqueezySignature(rawBody, signature, secret)) {
    console.warn("[lemonsqueezy] rejected webhook with invalid signature");
    throw new LetmepostError({
      code: "unauthenticated",
      status: 401,
      message: "Invalid Lemon Squeezy webhook signature.",
    });
  }

  const eventId = createHash("sha256").update(rawBody).digest("hex");

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
      signatureValid: true,
      organizationId: orgIdFromPayload,
    })
    .onConflictDoNothing({ target: billingEvents.lsEventId })
    .returning();

  if (inserted.length === 0) {
    return c.json({ ok: true, deduped: true });
  }
  const rowId = inserted[0]!.id;

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

    // Surface payload-shape problems in the audit row so misconfigured
    // checkout URLs ("forgot to pass custom_data.organization_id") are
    // findable instead of indistinguishable from a no-op event.
    const processingError =
      result.mutated || result.organizationId
        ? null
        : "missing_organization_id_in_custom_data";

    await c.var.db
      .update(billingEvents)
      .set({
        processedAt: new Date(),
        ...(processingError ? { processingError } : {}),
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
