import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { eq } from "drizzle-orm";
import type { WebhookEventType } from "@letmepost/schemas";
import { createApp } from "../src/app.js";
import { periodFor } from "../src/billing/period.js";
import { apiKeys } from "../src/db/schema/api_keys.js";
import { billingUsage } from "../src/db/schema/billing_usage.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import { seed, type SeedFixture } from "../src/db/seed.js";
import type { DrizzleClient } from "../src/db/index.js";
import type { PublishEnqueuer } from "../src/queue/enqueue.js";
import type { PublishJobData } from "../src/queue/queues.js";
import {
  processPublishJob,
  type PublishJobDeps,
} from "../src/queue/publish-processor.js";
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import type { WebhookDispatcher } from "../src/webhooks/dispatch.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

/**
 * Sandbox (`lmp_test_`) contract. The load-bearing assertion in every test
 * here is the upstream call counter: a live handler IS registered for X, so a
 * leaked platform write would succeed and only the counter would catch it.
 * Asserting on response shape alone would not.
 */

const TWEETS_URL = "https://api.twitter.com/2/tweets";

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

/** Working X handler + a counter. Any sandbox publish that reaches it fails. */
function twitterProbe(): { calls: () => number } {
  let calls = 0;
  server.use(
    http.post(TWEETS_URL, () => {
      calls += 1;
      return HttpResponse.json({ data: { id: "1700000001", text: "hello" } });
    }),
  );
  return { calls: () => calls };
}

type CapturedEvent = {
  organizationId: string;
  type: WebhookEventType;
  data: unknown;
};

function captureDispatcher(): {
  dispatcher: WebhookDispatcher;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  return {
    events,
    dispatcher: {
      async dispatch(ev) {
        events.push(ev);
      },
    },
  };
}

function captureEnqueuer(): {
  enqueuer: PublishEnqueuer;
  calls: Array<{ data: PublishJobData; delayMs: number | undefined }>;
} {
  const calls: Array<{ data: PublishJobData; delayMs: number | undefined }> = [];
  return {
    calls,
    enqueuer: {
      async enqueue(data, opts) {
        calls.push({ data, delayMs: opts?.delayMs });
      },
      async remove() {},
    },
  };
}

/**
 * One org, one X account, one live key and one sandbox key. Both keys address
 * the same real connected account; sandbox has no synthetic-account concept.
 */
async function seedBothEnvironments(tx: DrizzleClient): Promise<{
  live: SeedFixture;
  sandboxKey: string;
  accountId: string;
}> {
  const live = await seed(tx, { apiKeyPrefix: "lmp_live_" });
  const repo = new DrizzlePlatformAccountsRepository(tx);
  const account = await repo.create({
    organizationId: live.organizationId,
    profileId: live.profileId,
    platform: "twitter",
    platformAccountId: "twitter-user-1",
    displayName: "twitter-user-1",
    token: "access-token-xyz",
    tokenMetadata: { username: "alice" },
  });

  const sandboxKey = `lmp_test_${randomBytes(24).toString("base64url")}`;
  await tx.insert(apiKeys).values({
    organizationId: live.organizationId,
    name: "sandbox-fixture",
    prefix: "lmp_test_",
    hashedKey: createHash("sha256").update(sandboxKey).digest("hex"),
    last4: sandboxKey.slice(-4),
    scopes: ["posts:read", "posts:write"],
  });

  return { live, sandboxKey, accountId: account.id };
}

function publish(
  app: ReturnType<typeof createApp>,
  apiKey: string,
  body: unknown,
) {
  return app.request("/v1/posts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

async function readUsage(
  tx: DrizzleClient,
  organizationId: string,
): Promise<number> {
  const rows = await tx
    .select()
    .from(billingUsage)
    .where(eq(billingUsage.organizationId, organizationId));
  const row = rows.find((r) => r.period === periodFor());
  return row?.postsCount ?? 0;
}

type TargetResult = {
  accountId: string;
  platform: string;
  postId: string;
  status: string;
  uri?: string;
  cid?: string;
  warnings?: Array<{ code: string; message: string }>;
};

describeIfDb("POST /v1/posts (sandbox lmp_test_ keys)", () => {
  it("publishes with no outbound platform call and synthetic ids", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { live, sandboxKey, accountId } = await seedBothEnvironments(tx);
      const probe = twitterProbe();
      const { dispatcher, events } = captureDispatcher();
      const app = createApp({ db: tx, webhookDispatcher: dispatcher });

      const res = await publish(app, sandboxKey, {
        targets: [{ accountId }],
        text: "hello from sandbox",
      });

      expect(res.status).toBe(200);
      expect(probe.calls()).toBe(0);

      const body = (await res.json()) as {
        status: string;
        results: TargetResult[];
      };
      expect(body.status).toBe("published");
      const result = body.results[0]!;
      expect(result.platform).toBe("twitter");
      expect(result.status).toBe("published");
      expect(result.accountId).toBe(accountId);
      expect(result.cid).toMatch(/^sandbox_/);
      expect(result.uri).toContain("sandbox.letmepost.dev");
      expect(result.warnings?.[0]?.code).toBe("sandbox.no_platform_write");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, result.postId));
      expect(row?.sandbox).toBe(true);
      expect(row?.status).toBe("published");
      expect(row?.organizationId).toBe(live.organizationId);

      const published = events.find((e) => e.type === "post.published");
      expect(published).toBeDefined();
      expect((published!.data as { sandbox?: boolean }).sandbox).toBe(true);
    });
  });

  it("leaves quota untouched across repeated sandbox publishes", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { live, sandboxKey, accountId } = await seedBothEnvironments(tx);
      const probe = twitterProbe();
      const app = createApp({ db: tx });

      for (let i = 0; i < 4; i++) {
        const res = await publish(app, sandboxKey, {
          targets: [{ accountId }],
          text: `sandbox ${i}`,
        });
        expect(res.status).toBe(200);
      }
      expect(probe.calls()).toBe(0);
      expect(await readUsage(tx, live.organizationId)).toBe(0);

      // Control: the same publish on a live key does meter, proving the
      // counter above is zero because sandbox skipped it, not because the
      // meter is broken.
      const liveRes = await publish(app, live.apiKey.plaintext, {
        targets: [{ accountId }],
        text: "live one",
      });
      expect(liveRes.status).toBe(200);
      expect(probe.calls()).toBe(1);
      expect(await readUsage(tx, live.organizationId)).toBe(1);
    });
  });

  it("returns the identical preflight error body in sandbox and live", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { live, sandboxKey, accountId } = await seedBothEnvironments(tx);
      const probe = twitterProbe();
      const app = createApp({ db: tx });
      const tooLong = {
        targets: [{ accountId }],
        text: "a".repeat(281),
      };

      const sandboxRes = await publish(app, sandboxKey, tooLong);
      const liveRes = await publish(app, live.apiKey.plaintext, tooLong);

      expect(sandboxRes.status).toBe(400);
      expect(liveRes.status).toBe(sandboxRes.status);

      const sandboxBody = (await sandboxRes.json()) as {
        error: Record<string, unknown>;
      };
      const liveBody = (await liveRes.json()) as {
        error: Record<string, unknown>;
      };
      // requestId differs per request; the error contract must not.
      const { requestId: _s, ...sandboxError } = sandboxBody.error;
      const { requestId: _l, ...liveError } = liveBody.error;
      expect(sandboxError).toEqual(liveError);
      expect(sandboxBody.error.code).toBe("preflight_failed");
      expect(sandboxBody.error.rule).toBe("twitter.text.max_graphemes");

      expect(probe.calls()).toBe(0);
      // A rejected batch persists nothing and charges nothing, either side.
      const rows = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.organizationId, live.organizationId));
      expect(rows).toHaveLength(0);
      expect(await readUsage(tx, live.organizationId)).toBe(0);
    });
  });

  it("schedules, fires on time, and still makes no platform call", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { live, sandboxKey, accountId } = await seedBothEnvironments(tx);
      const probe = twitterProbe();
      const { dispatcher, events } = captureDispatcher();
      const { enqueuer, calls } = captureEnqueuer();
      const app = createApp({
        db: tx,
        webhookDispatcher: dispatcher,
        publishEnqueuer: enqueuer,
      });

      const when = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await publish(app, sandboxKey, {
        targets: [{ accountId }],
        text: "scheduled sandbox",
        scheduledAt: when,
      });
      expect(res.status).toBe(202);

      const body = (await res.json()) as {
        status: string;
        results: TargetResult[];
      };
      expect(body.status).toBe("queued");
      const postId = body.results[0]!.postId;

      // The job is enqueued exactly as a live scheduled post would be.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.data.postId).toBe(postId);
      expect(calls[0]!.delayMs).toBeGreaterThan(0);

      const [queued] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, postId));
      expect(queued?.status).toBe("queued");
      expect(queued?.sandbox).toBe(true);
      expect(await readUsage(tx, live.organizationId)).toBe(0);

      // Fire it: the worker has no API-key context and must read sandbox
      // off the row.
      const deps: PublishJobDeps = {
        db: tx,
        dispatcher,
        getTikTokPollQueue: () => {
          throw new Error("no TikTok poll queue expected");
        },
      };
      const outcome = (await processPublishJob(
        {
          data: { postId, organizationId: live.organizationId },
          attemptsMade: 0,
          opts: { attempts: 3 },
        },
        deps,
      )) as { ok?: boolean; uri?: string };

      expect(probe.calls()).toBe(0);
      expect(outcome.ok).toBe(true);
      expect(outcome.uri).toContain("sandbox.letmepost.dev");

      const [fired] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, postId));
      expect(fired?.status).toBe("published");
      expect(fired?.platformCid).toMatch(/^sandbox_/);
      expect(fired?.sandbox).toBe(true);

      const published = events.find((e) => e.type === "post.published");
      expect(published).toBeDefined();
      expect((published!.data as { sandbox?: boolean }).sandbox).toBe(true);
      expect(await readUsage(tx, live.organizationId)).toBe(0);
    });
  });

  it("refuses to let a sandbox key re-drive a live post row", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { live, sandboxKey, accountId } = await seedBothEnvironments(tx);
      const probe = twitterProbe();
      const { enqueuer, calls } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const [liveRow] = await tx
        .insert(postsTable)
        .values({
          organizationId: live.organizationId,
          accountId,
          status: "failed",
          text: "a live post that failed",
        })
        .returning();

      const res = await app.request(`/v1/posts/${liveRow!.id}/retry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sandboxKey}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("api_key.environment_scope");
      expect(calls).toHaveLength(0);
      expect(probe.calls()).toBe(0);
    });
  });

  it("still rejects an invalid or revoked test key with 401", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { accountId } = await seedBothEnvironments(tx);
      const app = createApp({ db: tx });
      const res = await publish(app, "lmp_test_not-a-real-key", {
        targets: [{ accountId }],
        text: "nope",
      });
      expect(res.status).toBe(401);
    });
  });

  it("leaves live keys entirely unaffected", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { live, accountId } = await seedBothEnvironments(tx);
      const probe = twitterProbe();
      const app = createApp({ db: tx });

      const res = await publish(app, live.apiKey.plaintext, {
        targets: [{ accountId }],
        text: "live publish",
      });
      expect(res.status).toBe(200);
      expect(probe.calls()).toBe(1);

      const body = (await res.json()) as {
        status: string;
        results: TargetResult[];
      };
      expect(body.status).toBe("published");
      const result = body.results[0]!;
      expect(result.uri).toContain("twitter.com");
      expect(result.cid).toBeUndefined();
      expect(result.warnings).toBeUndefined();

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, result.postId));
      expect(row?.sandbox).toBe(false);
      expect(await readUsage(tx, live.organizationId)).toBe(1);
    });
  });
});
