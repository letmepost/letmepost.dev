import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";
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
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import type { WebhookDispatcher } from "../src/webhooks/dispatch.js";
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

describeIfDbInteg(
  "billing/quota — POST /v1/posts charges only accepted, published work",
  () => {
    async function currentCount(
      db: import("../src/db/index.js").DrizzleClient,
      organizationId: string,
    ): Promise<number> {
      const [row] = await db
        .select()
        .from(billingUsage)
        .where(
          and(
            eq(billingUsage.organizationId, organizationId),
            eq(billingUsage.period, periodFor()),
          ),
        );
      return row?.postsCount ?? 0;
    }

    function withBillingEnabled<T>(fn: () => Promise<T>): Promise<T> {
      const prev = process.env.BILLING_ENABLED;
      process.env.BILLING_ENABLED = "true";
      return fn().finally(() => {
        if (prev === undefined) delete process.env.BILLING_ENABLED;
        else process.env.BILLING_ENABLED = prev;
      });
    }

    // createSession returns a DID derived from the identifier; createRecord
    // succeeds unless the record targets `rejectDid`, letting one target in a
    // batch fail at publish while its batch-mate succeeds.
    function blueskyDidHandlers(rejectDid?: string) {
      return [
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          async ({ request }) => {
            const body = (await request.json()) as { identifier: string };
            const did = `did:plc:${body.identifier.split(".")[0]}`;
            return HttpResponse.json({
              accessJwt: "a",
              refreshJwt: "r",
              did,
              handle: body.identifier,
            });
          },
        ),
        http.post(
          "https://bsky.social/xrpc/com.atproto.repo.createRecord",
          async ({ request }) => {
            const body = (await request.json()) as { repo: string };
            if (rejectDid && body.repo === rejectDid) {
              return HttpResponse.json(
                { error: "InvalidRequest", message: "Record validation failed" },
                { status: 400 },
              );
            }
            return HttpResponse.json({
              uri: `at://${body.repo}/app.bsky.feed.post/x`,
              cid: "bafy-mock",
            });
          },
        ),
      ];
    }

    it("a request that fails request-level validation consumes zero quota", async () => {
      await withBillingEnabled(async () => {
        const { db } = await getTestDb();
        await runInTransaction(db, async (tx) => {
          const fixture = await seed(tx);
          await tx.insert(billingSubscriptions).values({
            organizationId: fixture.organizationId,
            tier: "free",
            status: "free",
          });

          const app = createApp({ db: tx });
          // scheduledAt in the past → validation_failed (scheduledAt.future),
          // which is checked before the quota is ever consumed.
          const res = await app.request("/v1/posts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${fixture.apiKey.plaintext}`,
            },
            body: JSON.stringify({
              targets: [{ accountId: fixture.accountId }],
              text: "should never publish",
              scheduledAt: new Date(Date.now() - 3600_000).toISOString(),
            }),
          });

          expect(res.status).toBe(400);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe("validation_failed");
          expect(await currentCount(tx, fixture.organizationId)).toBe(0);
        });
      });
    });

    it("a batch with one target rejected pre-publish charges nothing (all-or-nothing)", async () => {
      await withBillingEnabled(async () => {
        const { db } = await getTestDb();
        await runInTransaction(db, async (tx) => {
          const fixture = await seed(tx);
          await tx.insert(billingSubscriptions).values({
            organizationId: fixture.organizationId,
            tier: "free",
            status: "free",
          });

          const app = createApp({ db: tx });
          // One valid target + one unknown accountId. Resolution 404s the whole
          // batch before the quota gate, so the valid target is NOT charged.
          const res = await app.request("/v1/posts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${fixture.apiKey.plaintext}`,
            },
            body: JSON.stringify({
              targets: [
                { accountId: fixture.accountId },
                { accountId: randomUUID() },
              ],
              text: "half-invalid batch",
            }),
          });

          expect(res.status).toBe(404);
          expect(await currentCount(tx, fixture.organizationId)).toBe(0);
        });
      });
    });

    it("a successful publish is counted exactly once", async () => {
      await withBillingEnabled(async () => {
        const { db } = await getTestDb();
        await runInTransaction(db, async (tx) => {
          const fixture = await seed(tx);
          await tx.insert(billingSubscriptions).values({
            organizationId: fixture.organizationId,
            tier: "free",
            status: "free",
          });

          server.use(...blueskyDidHandlers());
          const app = createApp({ db: tx });
          const res = await app.request("/v1/posts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${fixture.apiKey.plaintext}`,
            },
            body: JSON.stringify({
              targets: [{ accountId: fixture.accountId }],
              text: "hello world",
            }),
          });

          expect(res.status).toBe(200);
          const body = (await res.json()) as { status: string };
          expect(body.status).toBe("published");
          expect(await currentCount(tx, fixture.organizationId)).toBe(1);
        });
      });
    });

    it("a publish that fails at the platform is refunded (net zero)", async () => {
      await withBillingEnabled(async () => {
        const { db } = await getTestDb();
        await runInTransaction(db, async (tx) => {
          const fixture = await seed(tx);
          await tx.insert(billingSubscriptions).values({
            organizationId: fixture.organizationId,
            tier: "free",
            status: "free",
          });

          const repo = new DrizzlePlatformAccountsRepository(tx);
          const account = await repo.findById(fixture.accountId);
          const rejectDid = `did:plc:${account!.platformAccountId.split(".")[0]}`;
          server.use(...blueskyDidHandlers(rejectDid));

          const app = createApp({ db: tx });
          const res = await app.request("/v1/posts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${fixture.apiKey.plaintext}`,
            },
            body: JSON.stringify({
              targets: [{ accountId: fixture.accountId }],
              text: "will be rejected",
            }),
          });

          expect(res.status).toBe(200);
          const body = (await res.json()) as { status: string };
          expect(body.status).toBe("failed");
          // Charged one slot up front, refunded when the send never went out.
          expect(await currentCount(tx, fixture.organizationId)).toBe(0);
        });
      });
    });

    it("in a batch, only the target that actually published is charged", async () => {
      await withBillingEnabled(async () => {
        const { db } = await getTestDb();
        await runInTransaction(db, async (tx) => {
          const fixture = await seed(tx);
          await tx.insert(billingSubscriptions).values({
            organizationId: fixture.organizationId,
            tier: "free",
            status: "free",
          });

          const repo = new DrizzlePlatformAccountsRepository(tx);
          const accountA = await repo.create({
            organizationId: fixture.organizationId,
            profileId: fixture.profileId,
            platform: "bluesky",
            platformAccountId: "accta.bsky.social",
            displayName: "acct a",
            token: "pw-a",
            tokenMetadata: { handle: "accta.bsky.social" },
          });
          const accountB = await repo.create({
            organizationId: fixture.organizationId,
            profileId: fixture.profileId,
            platform: "bluesky",
            platformAccountId: "acctb.bsky.social",
            displayName: "acct b",
            token: "pw-b",
            tokenMetadata: { handle: "acctb.bsky.social" },
          });

          // B's publish is rejected; A's succeeds.
          server.use(...blueskyDidHandlers("did:plc:acctb"));

          const app = createApp({ db: tx });
          const res = await app.request("/v1/posts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${fixture.apiKey.plaintext}`,
            },
            body: JSON.stringify({
              targets: [{ accountId: accountA.id }, { accountId: accountB.id }],
              text: "one lands, one fails",
            }),
          });

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            status: string;
            results: Array<{ status: string }>;
          };
          expect(body.status).toBe("partial_failed");
          expect(body.results[0]!.status).toBe("published");
          expect(body.results[1]!.status).toBe("rejected");
          // Charged 2 up front, refunded the 1 that failed → only the published
          // target is billed.
          expect(await currentCount(tx, fixture.organizationId)).toBe(1);
        });
      });
    });

    it("still returns 429 quota_exceeded when genuinely over the cap", async () => {
      await withBillingEnabled(async () => {
        const { db } = await getTestDb();
        await runInTransaction(db, async (tx) => {
          const fixture = await seed(tx);
          await tx.insert(billingSubscriptions).values({
            organizationId: fixture.organizationId,
            tier: "free",
            status: "free",
          });
          // Free cap is 50; pre-fill to the cap so the next slot is refused.
          await tx.insert(billingUsage).values({
            organizationId: fixture.organizationId,
            period: periodFor(),
            postsCount: 50,
          });

          server.use(...blueskyDidHandlers());
          const app = createApp({ db: tx });
          const res = await app.request("/v1/posts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${fixture.apiKey.plaintext}`,
            },
            body: JSON.stringify({
              targets: [{ accountId: fixture.accountId }],
              text: "over the cap",
            }),
          });

          expect(res.status).toBe(429);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe("quota_exceeded");
          // Counter untouched — the gate refuses before persisting.
          expect(await currentCount(tx, fixture.organizationId)).toBe(50);
        });
      });
    });
  },
);
