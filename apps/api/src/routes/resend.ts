import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { Webhook, WebhookVerificationError } from "svix";
import { emailSuppressions } from "../db/schema/email_suppressions.js";
import { LetmepostError } from "../errors.js";

export const resendWebhook = new Hono();

// POST /v1/resend/webhook
//
// Resend signs webhooks via Svix. We verify the headers against
// RESEND_WEBHOOK_SECRET, then write hard-bounce and complaint events
// to the suppression list so future onboarding/transactional sends
// short-circuit before hitting Resend.
//
// Why we suppress on bounce + complaint:
//   - email.bounced (permanent): the address is dead, future sends
//     burn sender reputation.
//   - email.complained: the recipient hit "spam". Gmail/Yahoo's
//     sender rules require us to stop sending immediately or risk
//     being filtered for everyone.
//
// Soft bounces (bounceType: "transient") are deliberately NOT
// suppressed — they retry naturally on the next sequence email.
resendWebhook.post("/webhook", async (c) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message: "RESEND_WEBHOOK_SECRET is not configured.",
    });
  }

  const rawBody = await c.req.raw.clone().text();

  // Svix verification needs the three signed headers verbatim.
  const svixHeaders = {
    "svix-id": c.req.header("svix-id") ?? "",
    "svix-timestamp": c.req.header("svix-timestamp") ?? "",
    "svix-signature": c.req.header("svix-signature") ?? "",
  };

  let event: ResendWebhookEvent;
  try {
    event = new Webhook(secret).verify(rawBody, svixHeaders) as ResendWebhookEvent;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      console.warn("[resend] rejected webhook with invalid signature");
      throw new LetmepostError({
        code: "unauthenticated",
        status: 401,
        message: "Invalid Resend webhook signature.",
      });
    }
    throw err;
  }

  const recipient = extractRecipient(event);
  if (!recipient) {
    return c.json({ ok: true, ignored: "no_recipient" });
  }

  const eventId =
    (event as { id?: string }).id ?? svixHeaders["svix-id"] ?? null;

  if (event.type === "email.complained") {
    await c.var.db
      .insert(emailSuppressions)
      .values({
        email: recipient.toLowerCase(),
        reason: "complained",
        sourceRef: eventId,
      })
      .onConflictDoNothing({ target: emailSuppressions.email });
    await cancelOnboardingForEmail(c.var.db, recipient);
    return c.json({ ok: true, suppressed: "complained" });
  }

  if (event.type === "email.bounced") {
    // Soft bounces (mailbox-full, deferred, etc.) shouldn't suppress.
    // Resend's payload exposes bounceType on `data.bounce.type` for
    // recent webhook versions; older payloads put it at the top of
    // data. We treat anything that isn't explicitly "transient" as a
    // permanent bounce — safer to over-suppress than to keep mailing
    // a dead address.
    const bounceType =
      (event.data as { bounce?: { type?: string }; bounceType?: string })
        ?.bounce?.type ??
      (event.data as { bounceType?: string }).bounceType ??
      "permanent";
    if (bounceType === "transient") {
      return c.json({ ok: true, ignored: "soft_bounce" });
    }
    await c.var.db
      .insert(emailSuppressions)
      .values({
        email: recipient.toLowerCase(),
        reason: "bounced_hard",
        sourceRef: eventId,
      })
      .onConflictDoNothing({ target: emailSuppressions.email });
    await cancelOnboardingForEmail(c.var.db, recipient);
    return c.json({ ok: true, suppressed: "bounced_hard" });
  }

  // delivered, opened, clicked, sent, etc. — no action, just 200.
  return c.json({ ok: true, handled: false });
});

// Resend payloads vary slightly across event types. We only care
// about the recipient email; pluck it from the two known shapes.
function extractRecipient(event: ResendWebhookEvent): string | null {
  const data = event.data as { to?: string | string[]; email?: string };
  if (typeof data?.email === "string") return data.email;
  if (typeof data?.to === "string") return data.to;
  if (Array.isArray(data?.to) && typeof data.to[0] === "string") {
    return data.to[0];
  }
  return null;
}

// Best-effort job cancellation. The suppression-list check inside
// processOnboardingEmail is the load-bearing guard; this is a fast
// path so we don't waste queue work on a now-suppressed address.
// Imported lazily to avoid pulling BullMQ into hot routes.
async function cancelOnboardingForEmail(
  _db: unknown,
  email: string,
): Promise<void> {
  try {
    const { getOnboardingEmailQueue } = await import("../queue/queues.js");
    const queue = getOnboardingEmailQueue();
    // Walk delayed + waiting jobs and remove anything addressed to
    // this recipient. Cheap at launch volume; if the queue grows past
    // a few thousand pending we'll want a secondary index instead.
    const jobs = await queue.getJobs(["delayed", "waiting"]);
    for (const job of jobs) {
      if (job.data?.email?.toLowerCase() === email.toLowerCase()) {
        await job.remove().catch(() => {});
      }
    }
  } catch (err) {
    console.warn(
      "[resend] failed to cancel queued onboarding jobs:",
      err instanceof Error ? err.message : err,
    );
  }
}

type ResendWebhookEvent = {
  type: string;
  data: Record<string, unknown>;
  id?: string;
};
