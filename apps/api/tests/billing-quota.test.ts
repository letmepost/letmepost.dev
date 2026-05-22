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
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { checkAndIncrementQuota } from "../src/billing/quota.js";
import { tierCache } from "../src/billing/cache.js";
import { periodFor } from "../src/billing/period.js";
import { billingSubscriptions } from "../src/db/schema/billing_subscriptions.js";
import { billingUsage } from "../src/db/schema/billing_usage.js";
import { LetmepostError } from "../src/errors.js";
import { seed } from "../src/db/seed.js";
import type { WebhookDispatcher } from "../src/webhooks/dispatch.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

beforeEach(() => {
  tierCache.clear();
});

function recordingDispatcher(): {
  dispatcher: WebhookDispatcher;
  events: Array<{ organizationId: string; type: string; data: unknown }>;
} {
  const events: Array<{
    organizationId: string;
    type: string;
    data: unknown;
  }> = [];
  return {
    events,
    dispatcher: {
      async dispatch(params) {
        events.push({
          organizationId: params.organizationId,
          type: params.type,
          data: params.data,
        });
      },
    },
  };
}

describeIfDb("billing/quota — atomic increment", () => {
  it("increments the counter when below the cap", async () => {
    const prev = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = "true";
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        // Seed a free row directly to skip the lazy insert race.
        await tx.insert(billingSubscriptions).values({
          organizationId: fixture.organizationId,
          tier: "free",
          status: "free",
        });

        const result = await checkAndIncrementQuota(
          tx,
          fixture.organizationId,
          1,
        );
        expect(result.newCount).toBe(1);
        expect(result.quota).toBe(50);
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("counts the cost as one slot per target", async () => {
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
        const result = await checkAndIncrementQuota(
          tx,
          fixture.organizationId,
          3,
        );
        expect(result.newCount).toBe(3);
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("throws quota_exceeded and emits the exceeded event when the cap is hit", async () => {
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
        // Pre-fill the counter to one below the cap.
        await tx.insert(billingUsage).values({
          organizationId: fixture.organizationId,
          period: periodFor(),
          postsCount: 49,
        });

        const recorder = recordingDispatcher();
        const ok = await checkAndIncrementQuota(
          tx,
          fixture.organizationId,
          1,
          { webhookDispatcher: recorder.dispatcher },
        );
        expect(ok.newCount).toBe(50);

        // The next request must trip the cap.
        let thrown: unknown;
        try {
          await checkAndIncrementQuota(tx, fixture.organizationId, 1, {
            webhookDispatcher: recorder.dispatcher,
          });
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(LetmepostError);
        const err = thrown as LetmepostError;
        expect(err.code).toBe("quota_exceeded");
        expect(err.status).toBe(429);
        expect(err.rule).toBe("billing.posts.monthly_cap");

        const exceeded = recorder.events.filter(
          (e) => e.type === "quota.exceeded",
        );
        expect(exceeded.length).toBe(1);
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("fires quota.warning once per period when crossing 80%", async () => {
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
        // 80% of 50 == 40. Pre-fill to 39, then increment by 1 — crosses.
        await tx.insert(billingUsage).values({
          organizationId: fixture.organizationId,
          period: periodFor(),
          postsCount: 39,
        });
        const recorder = recordingDispatcher();

        await checkAndIncrementQuota(tx, fixture.organizationId, 1, {
          webhookDispatcher: recorder.dispatcher,
        });
        await checkAndIncrementQuota(tx, fixture.organizationId, 1, {
          webhookDispatcher: recorder.dispatcher,
        });
        const warnings = recorder.events.filter(
          (e) => e.type === "quota.warning",
        );
        expect(warnings.length).toBe(1);
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });

  it("skips the cap entirely when the resolved quota is Infinity (self_host)", async () => {
    // BILLING_ENABLED unset -> synthetic self_host. The function still records
    // the increment so the dashboard can show usage data.
    const prev = process.env.BILLING_ENABLED;
    delete process.env.BILLING_ENABLED;
    try {
      const { db } = await getTestDb();
      await runInTransaction(db, async (tx) => {
        const fixture = await seed(tx);
        const result = await checkAndIncrementQuota(
          tx,
          fixture.organizationId,
          1000,
        );
        expect(result.quota).toBe(Infinity);
        expect(result.newCount).toBe(1000);
      });
    } finally {
      if (prev !== undefined) process.env.BILLING_ENABLED = prev;
    }
  });

  it("records nothing extra on a re-entry past the cap (counter stays at cap)", async () => {
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
        await tx.insert(billingUsage).values({
          organizationId: fixture.organizationId,
          period: periodFor(),
          postsCount: 50,
        });
        await expect(
          checkAndIncrementQuota(tx, fixture.organizationId, 1),
        ).rejects.toBeInstanceOf(LetmepostError);

        // Counter must NOT have been bumped past the cap.
        const [row] = await tx
          .select()
          .from(billingUsage)
          .where(
            and(
              eq(billingUsage.organizationId, fixture.organizationId),
              eq(billingUsage.period, periodFor()),
            ),
          );
        expect(row?.postsCount).toBe(50);
      });
    } finally {
      if (prev === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prev;
    }
  });
});

const describeIfDbInteg = canRunDbTests ? describe : describe.skip;

describeIfDbInteg(
  "billing/quota — idempotent replay doesn't increment",
  () => {
    function blueskyHappyHandlers() {
      return [
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json({
              accessJwt: "a",
              refreshJwt: "r",
              did: "did:plc:test",
              handle: "alice.bsky.social",
            }),
        ),
        http.post(
          "https://bsky.social/xrpc/com.atproto.repo.createRecord",
          () =>
            HttpResponse.json({
              uri: "at://did:plc:test/app.bsky.feed.post/x",
              cid: "bafy-mock",
            }),
        ),
      ];
    }

    it("a retried Idempotency-Key replays the response without bumping the counter", async () => {
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

          server.use(...blueskyHappyHandlers());
          const app = createApp({ db: tx });
          const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixture.apiKey.plaintext}`,
            "Idempotency-Key": "idem_quota_replay_probe",
          };
          const body = JSON.stringify({
            targets: [{ accountId: fixture.accountId }],
            text: "hello idempotent world",
          });

          const first = await app.request("/v1/posts", {
            method: "POST",
            headers,
            body,
          });
          expect([200, 201]).toContain(first.status);

          const [afterFirst] = await tx
            .select()
            .from(billingUsage)
            .where(
              and(
                eq(billingUsage.organizationId, fixture.organizationId),
                eq(billingUsage.period, periodFor()),
              ),
            );
          expect(afterFirst?.postsCount).toBe(1);

          const second = await app.request("/v1/posts", {
            method: "POST",
            headers,
            body,
          });
          expect(second.headers.get("idempotency-replayed")).toBe("true");

          const [afterSecond] = await tx
            .select()
            .from(billingUsage)
            .where(
              and(
                eq(billingUsage.organizationId, fixture.organizationId),
                eq(billingUsage.period, periodFor()),
              ),
            );
          // The replay short-circuits before the handler — counter is still 1.
          expect(afterSecond?.postsCount).toBe(1);
        });
      } finally {
        if (prev === undefined) delete process.env.BILLING_ENABLED;
        else process.env.BILLING_ENABLED = prev;
      }
    });
  },
);
