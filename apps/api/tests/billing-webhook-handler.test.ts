import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { tierCache } from "../src/billing/cache.js";
import { verifyLemonSqueezySignature } from "../src/billing/lemonsqueezy/signature.js";
import { tierForVariant } from "../src/billing/lemonsqueezy/variants.js";
import { billingEvents } from "../src/db/schema/billing_events.js";
import { billingSubscriptions } from "../src/db/schema/billing_subscriptions.js";
import { seed } from "../src/db/seed.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

afterAll(async () => {
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

beforeEach(() => {
  tierCache.clear();
});

function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("billing/lemonsqueezy/signature — verifyLemonSqueezySignature", () => {
  it("returns true for a correctly signed body", () => {
    const body = JSON.stringify({ hello: "world" });
    const secret = "shhh";
    const sig = signPayload(body, secret);
    expect(verifyLemonSqueezySignature(body, sig, secret)).toBe(true);
  });

  it("returns false when the signature doesn't match", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(
      verifyLemonSqueezySignature(body, "deadbeef", "shhh"),
    ).toBe(false);
  });

  it("returns false on missing signature or secret", () => {
    expect(verifyLemonSqueezySignature("x", null, "shhh")).toBe(false);
    expect(verifyLemonSqueezySignature("x", "abc", "")).toBe(false);
  });
});

describe("billing/lemonsqueezy/variants — tierForVariant", () => {
  it("maps the env-configured ids to the canonical tier names", () => {
    const prev = {
      pro: process.env.LMSQ_VARIANT_PRO,
      biz: process.env.LMSQ_VARIANT_BUSINESS,
    };
    process.env.LMSQ_VARIANT_PRO = "100";
    process.env.LMSQ_VARIANT_BUSINESS = "200";
    try {
      expect(tierForVariant("100")).toBe("pro");
      expect(tierForVariant("200")).toBe("business");
      expect(() => tierForVariant("999")).toThrow(/Unknown/);
    } finally {
      if (prev.pro === undefined) delete process.env.LMSQ_VARIANT_PRO;
      else process.env.LMSQ_VARIANT_PRO = prev.pro;
      if (prev.biz === undefined) delete process.env.LMSQ_VARIANT_BUSINESS;
      else process.env.LMSQ_VARIANT_BUSINESS = prev.biz;
    }
  });
});

describeIfDb("POST /v1/lemonsqueezy/webhook", () => {
  it("rejects requests with a bad signature (401) and writes no audit row", async () => {
    const prev = process.env.LMSQ_WEBHOOK_SECRET;
    process.env.LMSQ_WEBHOOK_SECRET = "test-secret";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const body = JSON.stringify({ meta: { event_name: "subscription_created" } });
        const before = await tx.select().from(billingEvents);
        const app = createApp({ db: tx });
        const res = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature": "not-a-real-sig",
            "X-Event-Name": "subscription_created",
          },
          body,
        });
        expect(res.status).toBe(401);
        const json = (await res.json()) as {
          error: { code: string; message: string };
        };
        expect(json.error.code).toBe("unauthenticated");

        // Bad-sig requests must NOT create a billing_events row, otherwise
        // an attacker can fill the table with attacker-controlled JSON.
        const after = await tx.select().from(billingEvents);
        expect(after.length).toBe(before.length);
      });
    } finally {
      if (prev === undefined) delete process.env.LMSQ_WEBHOOK_SECRET;
      else process.env.LMSQ_WEBHOOK_SECRET = prev;
    }
  });

  it("dedupes replays keyed on body hash", async () => {
    const prev = process.env.LMSQ_WEBHOOK_SECRET;
    process.env.LMSQ_WEBHOOK_SECRET = "test-secret";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const body = JSON.stringify({
          meta: {
            event_name: "subscription_payment_refunded",
            custom_data: { organization_id: fixture.organizationId },
          },
          data: { id: "sub_1", attributes: {} },
        });
        const sig = signPayload(body, "test-secret");
        const app = createApp({ db: tx });
        const headers = {
          "Content-Type": "application/json",
          "X-Signature": sig,
          "X-Event-Name": "subscription_payment_refunded",
        };
        const first = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers,
          body,
        });
        expect(first.status).toBe(200);
        const second = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers,
          body,
        });
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual({ ok: true, deduped: true });
      });
    } finally {
      if (prev === undefined) delete process.env.LMSQ_WEBHOOK_SECRET;
      else process.env.LMSQ_WEBHOOK_SECRET = prev;
    }
  });

  it("subscription_created upserts the row at the mapped tier", async () => {
    const prev = {
      secret: process.env.LMSQ_WEBHOOK_SECRET,
      pro: process.env.LMSQ_VARIANT_PRO,
      enabled: process.env.BILLING_ENABLED,
    };
    process.env.LMSQ_WEBHOOK_SECRET = "test-secret";
    process.env.LMSQ_VARIANT_PRO = "v_pro_123";
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const body = JSON.stringify({
          meta: {
            event_name: "subscription_created",
            custom_data: { organization_id: fixture.organizationId },
          },
          data: {
            id: "sub_pro_1",
            type: "subscriptions",
            attributes: {
              variant_id: "v_pro_123",
              customer_id: "cust_1",
              product_id: "prod_1",
              renews_at: "2026-06-22T00:00:00Z",
              created_at: "2026-05-22T00:00:00Z",
              cancelled: false,
            },
          },
        });
        const sig = signPayload(body, "test-secret");
        const app = createApp({ db: tx });
        const res = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature": sig,
            "X-Event-Name": "subscription_created",
          },
          body,
        });
        expect(res.status).toBe(200);

        const [row] = await tx
          .select()
          .from(billingSubscriptions)
          .where(
            eq(billingSubscriptions.organizationId, fixture.organizationId),
          );
        expect(row?.tier).toBe("pro");
        expect(row?.status).toBe("active");
        expect(row?.lsSubscriptionId).toBe("sub_pro_1");
        expect(row?.lsCustomerId).toBe("cust_1");
      });
    } finally {
      for (const [k, v] of Object.entries(prev) as Array<
        [keyof typeof prev, string | undefined]
      >) {
        const envName =
          k === "secret"
            ? "LMSQ_WEBHOOK_SECRET"
            : k === "pro"
              ? "LMSQ_VARIANT_PRO"
              : "BILLING_ENABLED";
        if (v === undefined) delete process.env[envName];
        else process.env[envName] = v;
      }
    }
  });

  it("subscription_cancelled marks cancelAtPeriodEnd and keeps the tier", async () => {
    const prev = {
      secret: process.env.LMSQ_WEBHOOK_SECRET,
      pro: process.env.LMSQ_VARIANT_PRO,
    };
    process.env.LMSQ_WEBHOOK_SECRET = "test-secret";
    process.env.LMSQ_VARIANT_PRO = "v_pro_123";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "pro",
          status: "active",
          lsSubscriptionId: "sub_cancel_1",
          lsVariantId: "v_pro_123",
        });
        const body = JSON.stringify({
          meta: {
            event_name: "subscription_cancelled",
            custom_data: { organization_id: fixture.organizationId },
          },
          data: {
            id: "sub_cancel_1",
            attributes: {
              updated_at: "2026-05-22T00:00:00Z",
              ends_at: "2026-06-22T00:00:00Z",
            },
          },
        });
        const sig = signPayload(body, "test-secret");
        const app = createApp({ db: tx });
        const res = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature": sig,
            "X-Event-Name": "subscription_cancelled",
          },
          body,
        });
        expect(res.status).toBe(200);

        const [row] = await tx
          .select()
          .from(billingSubscriptions)
          .where(
            eq(billingSubscriptions.organizationId, fixture.organizationId),
          );
        expect(row?.tier).toBe("pro");
        expect(row?.status).toBe("cancelled");
        expect(row?.cancelAtPeriodEnd).toBe(true);
      });
    } finally {
      if (prev.secret === undefined) delete process.env.LMSQ_WEBHOOK_SECRET;
      else process.env.LMSQ_WEBHOOK_SECRET = prev.secret;
      if (prev.pro === undefined) delete process.env.LMSQ_VARIANT_PRO;
      else process.env.LMSQ_VARIANT_PRO = prev.pro;
    }
  });

  it("ignores out-of-order subscription_payment_success after subscription_expired", async () => {
    const prev = {
      secret: process.env.LMSQ_WEBHOOK_SECRET,
      pro: process.env.LMSQ_VARIANT_PRO,
    };
    process.env.LMSQ_WEBHOOK_SECRET = "test-secret";
    process.env.LMSQ_VARIANT_PRO = "v_pro_123";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        // Row is already expired (tier=free, status=free) from a prior event.
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "free",
          status: "free",
        });
        const body = JSON.stringify({
          meta: {
            event_name: "subscription_payment_success",
            custom_data: { organization_id: fixture.organizationId },
          },
          data: {
            id: "sub_ooo",
            attributes: { created_at: "2026-05-01T00:00:00Z" },
          },
        });
        const sig = signPayload(body, "test-secret");
        const app = createApp({ db: tx });
        const res = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature": sig,
            "X-Event-Name": "subscription_payment_success",
          },
          body,
        });
        expect(res.status).toBe(200);

        const [row] = await tx
          .select()
          .from(billingSubscriptions)
          .where(
            eq(billingSubscriptions.organizationId, fixture.organizationId),
          );
        // We only flip the status to active; the tier stays whatever the row
        // already had (free). Out-of-order arrivals don't resurrect the tier.
        expect(row?.tier).toBe("free");
      });
    } finally {
      if (prev.secret === undefined) delete process.env.LMSQ_WEBHOOK_SECRET;
      else process.env.LMSQ_WEBHOOK_SECRET = prev.secret;
      if (prev.pro === undefined) delete process.env.LMSQ_VARIANT_PRO;
      else process.env.LMSQ_VARIANT_PRO = prev.pro;
    }
  });

  it.each(["expired", "cancelled"] as const)(
    "subscription_updated carrying a %s status does not reinstate the paid tier after an expiry",
    async (lsStatus) => {
      const prev = {
        secret: process.env.LMSQ_WEBHOOK_SECRET,
        pro: process.env.LMSQ_VARIANT_PRO,
      };
      process.env.LMSQ_WEBHOOK_SECRET = "test-secret";
      process.env.LMSQ_VARIANT_PRO = "v_pro_123";
      try {
        const { db } = await getTestDb();
        await runInTransaction(db, async (tx) => {
          const fixture = await seed(tx);
          // subscription_expired already ran: tier/status wiped to free.
          await tx.insert(billingSubscriptions).values({
            organizationId: fixture.organizationId,
            tier: "free",
            status: "free",
          });
          // A late/out-of-order subscription_updated arrives still carrying the
          // paid variant id but a terminal status.
          const body = JSON.stringify({
            meta: {
              event_name: "subscription_updated",
              custom_data: { organization_id: fixture.organizationId },
            },
            data: {
              id: "sub_reinstate",
              type: "subscriptions",
              attributes: {
                variant_id: "v_pro_123",
                status: lsStatus,
                cancelled: lsStatus === "cancelled",
              },
            },
          });
          const sig = signPayload(body, "test-secret");
          const app = createApp({ db: tx });
          const res = await app.request("/v1/lemonsqueezy/webhook", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Signature": sig,
              "X-Event-Name": "subscription_updated",
            },
            body,
          });
          expect(res.status).toBe(200);

          const [row] = await tx
            .select()
            .from(billingSubscriptions)
            .where(
              eq(billingSubscriptions.organizationId, fixture.organizationId),
            );
          // Variant id must NOT re-grant the paid tier — the row stays free.
          expect(row?.tier).toBe("free");
          expect(row?.status).toBe(lsStatus);
        });
      } finally {
        if (prev.secret === undefined) delete process.env.LMSQ_WEBHOOK_SECRET;
        else process.env.LMSQ_WEBHOOK_SECRET = prev.secret;
        if (prev.pro === undefined) delete process.env.LMSQ_VARIANT_PRO;
        else process.env.LMSQ_VARIANT_PRO = prev.pro;
      }
    },
  );

  it("re-processes a failed event on retry until billing state converges", async () => {
    const prev = {
      secret: process.env.LMSQ_WEBHOOK_SECRET,
      pro: process.env.LMSQ_VARIANT_PRO,
      biz: process.env.LMSQ_VARIANT_BUSINESS,
    };
    process.env.LMSQ_WEBHOOK_SECRET = "test-secret";
    // First delivery lands while the variant→tier mapping is misconfigured, so
    // the handler throws. The event must NOT be marked processed, and Lemon
    // Squeezy's retry of the SAME event must be allowed to re-run and converge.
    delete process.env.LMSQ_VARIANT_PRO;
    delete process.env.LMSQ_VARIANT_BUSINESS;
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const body = JSON.stringify({
          meta: {
            event_name: "subscription_created",
            custom_data: { organization_id: fixture.organizationId },
          },
          data: {
            id: "sub_converge_1",
            type: "subscriptions",
            attributes: { variant_id: "v_pro_converge", customer_id: "cust_c" },
          },
        });
        const sig = signPayload(body, "test-secret");
        const app = createApp({ db: tx });
        const headers = {
          "Content-Type": "application/json",
          "X-Signature": sig,
          "X-Event-Name": "subscription_created",
        };

        // First attempt: handler throws (unknown variant) → non-2xx, no
        // subscription row, and the audit row is left un-processed.
        const first = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers,
          body,
        });
        expect(first.status).toBe(500);

        const afterFail = await tx
          .select()
          .from(billingEvents)
          .where(
            eq(billingEvents.organizationId, fixture.organizationId),
          );
        expect(afterFail.length).toBe(1);
        expect(afterFail[0]?.processedAt).toBeNull();
        expect(afterFail[0]?.processingError).toMatch(/Unknown/);

        const noSub = await tx
          .select()
          .from(billingSubscriptions)
          .where(
            eq(billingSubscriptions.organizationId, fixture.organizationId),
          );
        expect(noSub.length).toBe(0);

        // Fix the mapping and let Lemon Squeezy retry the SAME event. The prior
        // failed row must NOT dedup this away.
        process.env.LMSQ_VARIANT_PRO = "v_pro_converge";
        const retry = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers,
          body,
        });
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual({ ok: true, handled: true });

        // Same audit row, now finalized with the stale error cleared.
        const afterRetry = await tx
          .select()
          .from(billingEvents)
          .where(
            eq(billingEvents.organizationId, fixture.organizationId),
          );
        expect(afterRetry.length).toBe(1);
        expect(afterRetry[0]?.processedAt).not.toBeNull();
        expect(afterRetry[0]?.processingError).toBeNull();

        // Billing state converged: subscription now exists at the mapped tier.
        const [sub] = await tx
          .select()
          .from(billingSubscriptions)
          .where(
            eq(billingSubscriptions.organizationId, fixture.organizationId),
          );
        expect(sub?.tier).toBe("pro");
        expect(sub?.status).toBe("active");
        expect(sub?.lsSubscriptionId).toBe("sub_converge_1");
      });
    } finally {
      const restore = (name: string, val: string | undefined) => {
        if (val === undefined) delete process.env[name];
        else process.env[name] = val;
      };
      restore("LMSQ_WEBHOOK_SECRET", prev.secret);
      restore("LMSQ_VARIANT_PRO", prev.pro);
      restore("LMSQ_VARIANT_BUSINESS", prev.biz);
    }
  });

  it("skips a genuine duplicate of an already-succeeded event (no double-apply)", async () => {
    const prev = {
      secret: process.env.LMSQ_WEBHOOK_SECRET,
      pro: process.env.LMSQ_VARIANT_PRO,
    };
    process.env.LMSQ_WEBHOOK_SECRET = "test-secret";
    process.env.LMSQ_VARIANT_PRO = "v_pro_dup";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const body = JSON.stringify({
          meta: {
            event_name: "subscription_created",
            custom_data: { organization_id: fixture.organizationId },
          },
          data: {
            id: "sub_dup_1",
            type: "subscriptions",
            attributes: { variant_id: "v_pro_dup", customer_id: "cust_d" },
          },
        });
        const sig = signPayload(body, "test-secret");
        const app = createApp({ db: tx });
        const headers = {
          "Content-Type": "application/json",
          "X-Signature": sig,
          "X-Event-Name": "subscription_created",
        };

        const firstRes = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers,
          body,
        });
        expect(firstRes.status).toBe(200);
        expect(await firstRes.json()).toEqual({ ok: true, handled: true });

        // Exact replay of an already-processed event: skipped, not re-applied.
        const dup = await app.request("/v1/lemonsqueezy/webhook", {
          method: "POST",
          headers,
          body,
        });
        expect(dup.status).toBe(200);
        expect(await dup.json()).toEqual({ ok: true, deduped: true });

        // One audit row, one subscription row — the handler did not run twice.
        const events = await tx
          .select()
          .from(billingEvents)
          .where(
            eq(billingEvents.organizationId, fixture.organizationId),
          );
        expect(events.length).toBe(1);
        expect(events[0]?.processedAt).not.toBeNull();

        const subs = await tx
          .select()
          .from(billingSubscriptions)
          .where(
            eq(billingSubscriptions.organizationId, fixture.organizationId),
          );
        expect(subs.length).toBe(1);
        expect(subs[0]?.tier).toBe("pro");
      });
    } finally {
      if (prev.secret === undefined) delete process.env.LMSQ_WEBHOOK_SECRET;
      else process.env.LMSQ_WEBHOOK_SECRET = prev.secret;
      if (prev.pro === undefined) delete process.env.LMSQ_VARIANT_PRO;
      else process.env.LMSQ_VARIANT_PRO = prev.pro;
    }
  });
});
