import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
import { tierCache } from "../src/billing/cache.js";
import { billingSubscriptions } from "../src/db/schema/billing_subscriptions.js";
import { seed } from "../src/db/seed.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await closeTestDb();
});

beforeEach(() => {
  tierCache.clear();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

describeIfDb("billing routes", () => {
  it("POST /v1/billing/checkout posts custom_data to the LS Checkouts API and returns its URL", async () => {
    const prev = {
      pro: process.env.LMSQ_VARIANT_PRO,
      store: process.env.LMSQ_STORE_ID,
      base: process.env.LMSQ_API_BASE,
      key: process.env.LMSQ_API_KEY,
    };
    process.env.LMSQ_VARIANT_PRO = "v_pro_123";
    process.env.LMSQ_STORE_ID = "teststore";
    process.env.LMSQ_API_BASE = "https://ls.test/v1";
    process.env.LMSQ_API_KEY = "test-token";

    let received: {
      storeId?: string | undefined;
      variantId?: string | undefined;
      custom?: Record<string, string> | undefined;
    } = {};
    server.use(
      http.post("https://ls.test/v1/checkouts", async ({ request }) => {
        const body = (await request.json()) as {
          data?: {
            attributes?: { checkout_data?: { custom?: Record<string, string> } };
            relationships?: {
              store?: { data?: { id?: string } };
              variant?: { data?: { id?: string } };
            };
          };
        };
        received = {
          storeId: body.data?.relationships?.store?.data?.id,
          variantId: body.data?.relationships?.variant?.data?.id,
          custom: body.data?.attributes?.checkout_data?.custom,
        };
        return HttpResponse.json({
          data: {
            attributes: {
              url: "https://letmepost.lemonsqueezy.com/checkout/buy/abc?signature=xyz",
            },
          },
        });
      }),
    );

    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const app = createApp({
          db: tx,
          testSession: {
            userId: fixture.userId,
            organizationId: fixture.organizationId,
          },
        });
        const res = await app.request("/v1/billing/checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3001",
          },
          body: JSON.stringify({ targetTier: "pro" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string };
        expect(body.url).toBe(
          "https://letmepost.lemonsqueezy.com/checkout/buy/abc?signature=xyz",
        );
        expect(received.storeId).toBe("teststore");
        expect(received.variantId).toBe("v_pro_123");
        expect(received.custom).toEqual({
          organization_id: fixture.organizationId,
          user_id: fixture.userId,
        });
      });
    } finally {
      if (prev.pro === undefined) delete process.env.LMSQ_VARIANT_PRO;
      else process.env.LMSQ_VARIANT_PRO = prev.pro;
      if (prev.store === undefined) delete process.env.LMSQ_STORE_ID;
      else process.env.LMSQ_STORE_ID = prev.store;
      if (prev.base === undefined) delete process.env.LMSQ_API_BASE;
      else process.env.LMSQ_API_BASE = prev.base;
      if (prev.key === undefined) delete process.env.LMSQ_API_KEY;
      else process.env.LMSQ_API_KEY = prev.key;
    }
  });

  it("POST /v1/billing/portal proxies the LS customer-portal URL", async () => {
    const prev = {
      key: process.env.LMSQ_API_KEY,
      base: process.env.LMSQ_API_BASE,
    };
    process.env.LMSQ_API_KEY = "test-token";
    process.env.LMSQ_API_BASE = "https://ls.test/v1";

    server.use(
      http.get("https://ls.test/v1/customers/cust_42", () =>
        HttpResponse.json({
          data: {
            attributes: { urls: { customer_portal: "https://portal.ls.test/cust_42" } },
          },
        }),
      ),
    );

    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "pro",
          status: "active",
          lsCustomerId: "cust_42",
        });

        const app = createApp({
          db: tx,
          testSession: {
            userId: fixture.userId,
            organizationId: fixture.organizationId,
          },
        });
        const res = await app.request("/v1/billing/portal", {
          method: "POST",
          headers: { Origin: "http://localhost:3001" },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string };
        expect(body.url).toBe("https://portal.ls.test/cust_42");
      });
    } finally {
      if (prev.key === undefined) delete process.env.LMSQ_API_KEY;
      else process.env.LMSQ_API_KEY = prev.key;
      if (prev.base === undefined) delete process.env.LMSQ_API_BASE;
      else process.env.LMSQ_API_BASE = prev.base;
    }
  });

  it("GET /v1/billing/subscription returns the resolved tier", async () => {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "business",
          status: "active",
        });

        const app = createApp({
          db: tx,
          testSession: {
            userId: fixture.userId,
            organizationId: fixture.organizationId,
          },
        });
        const res = await app.request("/v1/billing/subscription");
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          tier: string;
          quotaPerMonth: number;
        };
        expect(body.tier).toBe("business");
        expect(body.quotaPerMonth).toBe(25_000);
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("POST /v1/billing/cancel rejects untrusted Origin (CSRF defense)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await tx.insert(billingSubscriptions).values({
        organizationId: fixture.organizationId,
        tier: "pro",
        status: "active",
        lsSubscriptionId: "sub_99",
      });
      const app = createApp({
        db: tx,
        testSession: {
          userId: fixture.userId,
          organizationId: fixture.organizationId,
        },
      });
      const res = await app.request("/v1/billing/cancel", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("unauthorized");
    });
  });

  it("POST /v1/billing/cancel rejects missing Origin", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await tx.insert(billingSubscriptions).values({
        organizationId: fixture.organizationId,
        tier: "pro",
        status: "active",
        lsSubscriptionId: "sub_99",
      });
      const app = createApp({
        db: tx,
        testSession: {
          userId: fixture.userId,
          organizationId: fixture.organizationId,
        },
      });
      const res = await app.request("/v1/billing/cancel", {
        method: "POST",
      });
      expect(res.status).toBe(403);
    });
  });

  it("GET /v1/billing/usage returns the current-period counter shape", async () => {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "free",
          status: "free",
        });
        const app = createApp({
          db: tx,
          testSession: {
            userId: fixture.userId,
            organizationId: fixture.organizationId,
          },
        });
        const res = await app.request("/v1/billing/usage");
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          period: string;
          postsCount: number;
          quota: number | null;
          percent: number;
          resetAt: string;
        };
        expect(body.period).toMatch(/^\d{4}-\d{2}$/);
        expect(body.postsCount).toBe(0);
        expect(body.quota).toBe(50);
        expect(body.percent).toBe(0);
        expect(typeof body.resetAt).toBe("string");
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });
});
