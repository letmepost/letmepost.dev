import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  createCheckoutUrl,
  cancelSubscription,
  listInvoicesForCustomer,
  mintCustomerPortalUrl,
  resumeSubscription,
} from "../billing/lemonsqueezy/client.js";
import {
  EVENT_HANDLERS,
  type LemonSqueezyPayload,
} from "../billing/lemonsqueezy/handlers.js";
import { invalidateOrgTier } from "../billing/invalidate.js";
import { periodFor, periodResetAt } from "../billing/period.js";
import { getOrgTier } from "../billing/tier.js";
import { billingSubscriptions } from "../db/schema/billing_subscriptions.js";
import { billingUsage } from "../db/schema/billing_usage.js";
import { member } from "../db/schema/auth.js";
import { LetmepostError } from "../errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { requireSession } from "../middleware/session.js";

export type BillingRoutesOptions = {
  /** Tests inject a session middleware so they can run without better-auth. */
  sessionMiddleware?: MiddlewareHandler;
};

const CheckoutRequest = z.object({
  targetTier: z.enum(["pro", "business"]),
});

const InvoiceQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Assert the signed-in user is an owner or admin on the active org. Members
 * still need to view billing state (so they can see why a publish is failing
 * with quota_exceeded) so the read routes leave this off; write routes call
 * it explicitly.
 */
async function requireAdmin(
  c: Parameters<MiddlewareHandler>[0],
): Promise<void> {
  const { userId, organizationId } = c.var.session;
  const [row] = await c.var.db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
    .limit(1);
  if (!row || (row.role !== "owner" && row.role !== "admin")) {
    throw new LetmepostError({
      code: "unauthorized",
      status: 403,
      message: "Only org owners and admins can manage billing.",
    });
  }
}

export function createBillingRoutes(
  opts: BillingRoutesOptions = {},
): Hono {
  const app = new Hono();
  const sessionMw = opts.sessionMiddleware ?? requireSession();

  app.use("*", sessionMw);
  app.use("*", rateLimit());

  /** GET /v1/billing/subscription — current tier + status. */
  app.get("/subscription", async (c) => {
    const { organizationId } = c.var.session;
    const tier = await getOrgTier(c.var.db, organizationId);
    return c.json({
      tier: tier.tier,
      status: tier.status,
      quotaPerMonth: Number.isFinite(tier.quotaPerMonth)
        ? tier.quotaPerMonth
        : null,
      logRetentionDays: Number.isFinite(tier.logRetentionDays)
        ? tier.logRetentionDays
        : null,
      grandfathered: tier.grandfathered,
      delinquent: tier.delinquent,
      source: tier.source,
      currentPeriodEnd: tier.currentPeriodEnd?.toISOString() ?? null,
    });
  });

  /** GET /v1/billing/usage — current-period counter. */
  app.get("/usage", async (c) => {
    const { organizationId } = c.var.session;
    const tier = await getOrgTier(c.var.db, organizationId);
    const period = periodFor();
    const resetAt = periodResetAt();
    const [row] = await c.var.db
      .select({ postsCount: billingUsage.postsCount })
      .from(billingUsage)
      .where(
        and(
          eq(billingUsage.organizationId, organizationId),
          eq(billingUsage.period, period),
        ),
      )
      .limit(1);
    const postsCount = row?.postsCount ?? 0;
    const quota = Number.isFinite(tier.quotaPerMonth) ? tier.quotaPerMonth : null;
    const percent =
      quota !== null && quota > 0 ? Math.min(1, postsCount / quota) : 0;
    return c.json({
      period,
      postsCount,
      quota,
      percent,
      resetAt: resetAt.toISOString(),
    });
  });

  /** POST /v1/billing/checkout — mint a hosted-checkout URL for a target tier. */
  app.post("/checkout", async (c) => {
    await requireAdmin(c);
    const raw = await c.req.json().catch(() => undefined);
    const parsed = CheckoutRequest.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: issue?.message ?? "Invalid request body.",
        rule: issue?.path.join(".") || "body",
      });
    }
    const { targetTier } = parsed.data;
    const variantEnv =
      targetTier === "pro"
        ? process.env.LMSQ_VARIANT_PRO
        : process.env.LMSQ_VARIANT_BUSINESS;
    if (!variantEnv) {
      throw new LetmepostError({
        code: "internal_error",
        status: 500,
        message: `Lemon Squeezy variant for tier "${targetTier}" is not configured.`,
      });
    }
    const url = await createCheckoutUrl(variantEnv, {
      organization_id: c.var.session.organizationId,
      user_id: c.var.session.userId,
    });
    return c.json({ url });
  });

  /** POST /v1/billing/portal — mint a customer-portal URL. */
  app.post("/portal", async (c) => {
    await requireAdmin(c);
    const { organizationId } = c.var.session;
    const [row] = await c.var.db
      .select({ lsCustomerId: billingSubscriptions.lsCustomerId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organizationId, organizationId))
      .limit(1);
    const customerId = row?.lsCustomerId;
    if (!customerId) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "This organization has no Lemon Squeezy customer record yet.",
        remediation: "Upgrade via /v1/billing/checkout first.",
      });
    }
    const url = await mintCustomerPortalUrl(customerId);
    if (!url) {
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 502,
        message: "Lemon Squeezy did not return a customer portal URL.",
        platform: "lemonsqueezy",
      });
    }
    return c.json({ url });
  });

  /** POST /v1/billing/sync — reconcile from LS by re-running the subscription handler. */
  app.post("/sync", async (c) => {
    await requireAdmin(c);
    const { organizationId } = c.var.session;
    const [row] = await c.var.db
      .select({
        lsSubscriptionId: billingSubscriptions.lsSubscriptionId,
        lsCustomerId: billingSubscriptions.lsCustomerId,
        lsVariantId: billingSubscriptions.lsVariantId,
        lsProductId: billingSubscriptions.lsProductId,
      })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organizationId, organizationId))
      .limit(1);
    if (!row?.lsSubscriptionId) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "Nothing to sync — no Lemon Squeezy subscription on file.",
      });
    }
    // We could call the LS GET /subscriptions/:id here and re-run the handler.
    // For now we just invalidate the tier cache so the next read re-reads.
    await invalidateOrgTier(organizationId);
    return c.json({ ok: true });
  });

  /** POST /v1/billing/cancel — cancel the active subscription via LS. */
  app.post("/cancel", async (c) => {
    await requireAdmin(c);
    const { organizationId } = c.var.session;
    const [row] = await c.var.db
      .select({
        lsSubscriptionId: billingSubscriptions.lsSubscriptionId,
      })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organizationId, organizationId))
      .limit(1);
    if (!row?.lsSubscriptionId) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "No active Lemon Squeezy subscription on this organization.",
      });
    }
    await cancelSubscription(row.lsSubscriptionId);
    await invalidateOrgTier(organizationId);
    return c.json({ ok: true });
  });

  /** POST /v1/billing/reactivate — undo cancel. */
  app.post("/reactivate", async (c) => {
    await requireAdmin(c);
    const { organizationId } = c.var.session;
    const [row] = await c.var.db
      .select({ lsSubscriptionId: billingSubscriptions.lsSubscriptionId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organizationId, organizationId))
      .limit(1);
    if (!row?.lsSubscriptionId) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "No Lemon Squeezy subscription on file.",
      });
    }
    await resumeSubscription(row.lsSubscriptionId);
    await invalidateOrgTier(organizationId);
    return c.json({ ok: true });
  });

  /** GET /v1/billing/invoices — paginated proxy. */
  app.get("/invoices", async (c) => {
    const { organizationId } = c.var.session;
    const parsed = InvoiceQuery.safeParse({
      page: c.req.query("page"),
      perPage: c.req.query("perPage"),
    });
    if (!parsed.success) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "Invalid pagination params.",
      });
    }
    const [row] = await c.var.db
      .select({ lsCustomerId: billingSubscriptions.lsCustomerId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organizationId, organizationId))
      .limit(1);
    if (!row?.lsCustomerId) {
      return c.json({ data: [], nextPage: null });
    }
    // Fail-soft: a Lemon Squeezy API hiccup on the invoices list shouldn't
    // gate the entire /billing page from rendering. Log the upstream error
    // for forensics and return an empty list so the dashboard stays usable.
    try {
      const result = await listInvoicesForCustomer(
        row.lsCustomerId,
        parsed.data.page,
        parsed.data.perPage,
      );
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[billing] listInvoicesForCustomer failed for org=${organizationId} customer=${row.lsCustomerId}: ${message}`,
      );
      return c.json({ data: [], nextPage: null });
    }
  });

  return app;
}

export const billingRoutes = createBillingRoutes();

// Re-export the handler map so other modules (the sync route, tests) can
// share it.
export { EVENT_HANDLERS };
export type { LemonSqueezyPayload };
