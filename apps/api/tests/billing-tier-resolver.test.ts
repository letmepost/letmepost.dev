import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getOrgTier } from "../src/billing/tier.js";
import { tierCache } from "../src/billing/cache.js";
import { TIERS } from "../src/billing/tiers.js";
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

describe("billing/tier — BILLING_ENABLED off", () => {
  it("returns synthetic self_host with Infinity quota when BILLING_ENABLED is unset", async () => {
    const prev = process.env.BILLING_ENABLED;
    delete process.env.BILLING_ENABLED;
    try {
      // Pass a fake db — the resolver short-circuits before touching it.
      const fakeDb = {} as never;
      const t = await getOrgTier(fakeDb, "any-org-id");
      expect(t.tier).toBe("self_host");
      expect(t.quotaPerMonth).toBe(Infinity);
      expect(t.source).toBe("billing_disabled");
    } finally {
      if (prev !== undefined) process.env.BILLING_ENABLED = prev;
    }
  });
});

describeIfDb("billing/tier — DB-backed resolution", () => {
  it("lazily inserts a free row for a new org and returns the free tier", async () => {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const t = await getOrgTier(tx, fixture.organizationId);
        expect(t.tier).toBe("free");
        expect(t.status).toBe("free");
        expect(t.quotaPerMonth).toBe(TIERS.free.quotaPerMonth);
        expect(t.source).toBe("default_free");

        const [row] = await tx
          .select()
          .from(billingSubscriptions)
          .where(eq(billingSubscriptions.organizationId, fixture.organizationId));
        expect(row).toBeDefined();
        expect(row?.tier).toBe("free");
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("forces quota to Infinity inside the grandfather window", async () => {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "free",
          status: "free",
          grandfatheredUntil: future,
        });
        const t = await getOrgTier(tx, fixture.organizationId);
        expect(t.grandfathered).toBe(true);
        expect(t.quotaPerMonth).toBe(Infinity);
        expect(t.source).toBe("grandfather");
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("caps the active quota at free quota when status is delinquent", async () => {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "pro",
          status: "delinquent",
        });
        const t = await getOrgTier(tx, fixture.organizationId);
        expect(t.tier).toBe("pro");
        expect(t.delinquent).toBe(true);
        expect(t.quotaPerMonth).toBe(TIERS.free.quotaPerMonth);
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("keeps the paid tier when cancelled but still inside the period", async () => {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const periodEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "business",
          status: "cancelled",
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: true,
        });
        const t = await getOrgTier(tx, fixture.organizationId);
        expect(t.tier).toBe("business");
        expect(t.quotaPerMonth).toBe(TIERS.business.quotaPerMonth);
        expect(t.currentPeriodEnd?.getTime()).toBe(periodEnd.getTime());
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("returns the row tier when no special-case rule applies", async () => {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "pro",
          status: "active",
        });
        const t = await getOrgTier(tx, fixture.organizationId);
        expect(t.tier).toBe("pro");
        expect(t.quotaPerMonth).toBe(TIERS.pro.quotaPerMonth);
        expect(t.source).toBe("subscription");
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });
});
