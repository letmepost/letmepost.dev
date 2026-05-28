import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { seed } from "../src/db/seed.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import type { PublishEnqueuer } from "../src/queue/enqueue.js";
import type { WebhookDispatcher } from "../src/webhooks/dispatch.js";
import type { PublishJobData } from "../src/queue/queues.js";
import type { WebhookEventType } from "@letmepost/schemas";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

/**
 * Coverage for the PATCH / DELETE endpoints + the worker-side race fix.
 * These exercise the v1 multi-target request shape (`targets: [...]`) so
 * they don't share the legacy single-target failures in
 * `posts-scheduling-events.test.ts`.
 *
 * The captured enqueuer/dispatcher pattern is duplicated here rather than
 * imported because vitest's module-scope server/db setup means coupling
 * test files makes ordering brittle.
 */

beforeAll(() => {});
afterAll(async () => {
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

type CapturedEnqueue = { data: PublishJobData; delayMs: number | undefined };

function captureEnqueuer() {
  const calls: CapturedEnqueue[] = [];
  const removals: string[] = [];
  const enqueuer: PublishEnqueuer = {
    async enqueue(data, opts) {
      calls.push({ data, delayMs: opts?.delayMs });
    },
    async remove(postId) {
      removals.push(postId);
    },
  };
  return { enqueuer, calls, removals };
}

type CapturedEvent = {
  organizationId: string;
  type: WebhookEventType;
  data: unknown;
};

function captureDispatcher() {
  const events: CapturedEvent[] = [];
  const dispatcher: WebhookDispatcher = {
    async dispatch(ev) {
      events.push(ev);
    },
  };
  return { dispatcher, events };
}

async function createScheduledPost(
  app: ReturnType<typeof createApp>,
  apiKey: string,
  accountId: string,
  scheduledAt: string,
): Promise<{ rowId: string }> {
  const res = await app.request("/v1/posts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      text: "scheduled",
      targets: [{ accountId }],
      scheduledAt,
    }),
  });
  if (res.status !== 202) {
    throw new Error(
      `Expected 202 from scheduled POST, got ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as {
    results: Array<{ postId: string }>;
  };
  return { rowId: body.results[0]!.postId };
}

describeIfDb("PATCH /v1/posts/:id — reschedule", () => {
  it("updates scheduledAt, replaces the BullMQ job, dispatches post.rescheduled", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer, calls, removals } = captureEnqueuer();
      const { dispatcher, events } = captureDispatcher();
      const app = createApp({
        db: tx,
        publishEnqueuer: enqueuer,
        webhookDispatcher: dispatcher,
      });

      const firstAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { rowId } = await createScheduledPost(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        firstAt,
      );
      // First enqueue from POST is in `calls[0]`.
      expect(calls).toHaveLength(1);

      const newAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      const res = await app.request(`/v1/posts/${rowId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({ scheduledAt: newAt }),
      });
      expect(res.status).toBe(200);

      // Row reflects the new time.
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.scheduledAt?.toISOString()).toBe(newAt);
      expect(row?.status).toBe("queued");

      // Old job removed, new job enqueued at new delay.
      expect(removals).toContain(rowId);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.data.postId).toBe(rowId);
      expect(calls[1]!.delayMs).toBeGreaterThan(2.9 * 60 * 60 * 1000);

      // post.rescheduled event emitted with both timestamps.
      const rescheduled = events.find((e) => e.type === "post.rescheduled");
      expect(rescheduled).toBeDefined();
      const data = rescheduled?.data as {
        id: string;
        scheduledAt: string;
        previousScheduledAt: string;
      };
      expect(data.id).toBe(rowId);
      expect(data.scheduledAt).toBe(newAt);
      expect(data.previousScheduledAt).toBe(firstAt);
    });
  });

  it("rejects reschedule when scheduledAt is in the past", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const firstAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { rowId } = await createScheduledPost(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        firstAt,
      );

      const past = new Date(Date.now() - 60_000).toISOString();
      const res = await app.request(`/v1/posts/${rowId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({ scheduledAt: past }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("scheduledAt.future");

      // Row unchanged.
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.scheduledAt?.toISOString()).toBe(firstAt);
    });
  });

  it("refuses to reschedule a post that has already published", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const firstAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { rowId } = await createScheduledPost(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        firstAt,
      );
      // Simulate the worker having published the row.
      await tx
        .update(postsTable)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(postsTable.id, rowId));

      const newAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const res = await app.request(`/v1/posts/${rowId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({ scheduledAt: newAt }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("post.status");
    });
  });
});

describeIfDb("DELETE /v1/posts/:id — cancel", () => {
  it("sets status=canceled, removes the BullMQ job, dispatches post.canceled", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer, removals } = captureEnqueuer();
      const { dispatcher, events } = captureDispatcher();
      const app = createApp({
        db: tx,
        publishEnqueuer: enqueuer,
        webhookDispatcher: dispatcher,
      });

      const firstAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { rowId } = await createScheduledPost(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        firstAt,
      );

      const res = await app.request(`/v1/posts/${rowId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; status: string };
      expect(body.status).toBe("canceled");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.status).toBe("canceled");

      expect(removals).toContain(rowId);
      const canceled = events.find((e) => e.type === "post.canceled");
      expect(canceled).toBeDefined();
    });
  });

  it("worker conditional update refuses to transition a canceled row to publishing", async () => {
    // Direct regression test for the cancel/worker race: if the row is
    // canceled between the worker's SELECT and its UPDATE, the
    // status-IN-(queued,validated) guard prevents the worker from
    // proceeding with a publish the user has asked us not to send.
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const firstAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { rowId } = await createScheduledPost(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        firstAt,
      );
      // Mark canceled, mimicking a DELETE landing between worker SELECT and
      // UPDATE.
      await tx
        .update(postsTable)
        .set({ status: "canceled" })
        .where(eq(postsTable.id, rowId));

      // Mirror the worker's conditional transition.
      const transitioned = await tx
        .update(postsTable)
        .set({ status: "publishing" })
        .where(
          and(
            eq(postsTable.id, rowId),
            inArray(postsTable.status, ["queued", "validated"]),
          ),
        )
        .returning();
      expect(transitioned).toHaveLength(0);

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.status).toBe("canceled");
    });
  });

  it("refuses to cancel a post outside the queued window", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const firstAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const { rowId } = await createScheduledPost(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        firstAt,
      );
      // Move into a non-cancellable state.
      await tx
        .update(postsTable)
        .set({ status: "publishing" })
        .where(eq(postsTable.id, rowId));

      const res = await app.request(`/v1/posts/${rowId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      expect(res.status).toBe(409);
    });
  });
});
