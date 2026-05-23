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
});
