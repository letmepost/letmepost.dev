import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
 * Content editing on a queued post — `PATCH /v1/posts/:id` with `text` and/or
 * `media`. Before this the endpoint took `scheduledAt` alone, so changing a
 * caption or swapping an image meant cancelling the post and composing it
 * again from scratch.
 *
 * Reschedule + cancel coverage lives in `posts-cancel-reschedule.test.ts`. The
 * captured enqueuer/dispatcher pattern is duplicated here rather than imported
 * for the same reason it is duplicated there: vitest's module-scope server/db
 * setup makes coupling test files brittle to ordering.
 */

beforeAll(() => {});
afterAll(async () => {
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

type CapturedEnqueue = { data: PublishJobData; delayMs: number | undefined };

function captureEnqueuer(opts?: { failEnqueueAfter?: number }) {
  const calls: CapturedEnqueue[] = [];
  const removals: string[] = [];
  const failAfter = opts?.failEnqueueAfter ?? Infinity;
  const enqueuer: PublishEnqueuer = {
    async enqueue(data, o) {
      if (calls.length >= failAfter) {
        throw new Error("queue unavailable");
      }
      calls.push({ data, delayMs: o?.delayMs });
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

async function createScheduled(
  app: ReturnType<typeof createApp>,
  apiKey: string,
  accountId: string,
  scheduledAt: string,
  media?: Array<{ kind: "image" | "video"; url: string }>,
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
      ...(media ? { media } : {}),
    }),
  });
  if (res.status !== 202) {
    throw new Error(
      `Expected 202 from scheduled POST, got ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { results: Array<{ postId: string }> };
  return { rowId: body.results[0]!.postId };
}

async function patch(
  app: ReturnType<typeof createApp>,
  apiKey: string,
  rowId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/v1/posts/${rowId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describeIfDb("PATCH /v1/posts/:id — edit content", () => {
  it("edits text without touching the queue, and emits post.updated", async () => {
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

      const at = IN_AN_HOUR();
      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        at,
      );
      expect(calls).toHaveLength(1);

      const res = await patch(app, fixture.apiKey.plaintext, rowId, {
        text: "edited caption",
      });
      expect(res.status).toBe(200);

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.text).toBe("edited caption");
      // The time did not move, so the job must be left exactly as it was: it
      // carries only the post id, and the worker re-reads the row when it
      // fires. Churning the queue here would be a needless failure surface.
      expect(row?.scheduledAt?.toISOString()).toBe(at);
      expect(removals).toHaveLength(0);
      expect(calls).toHaveLength(1);

      const updated = events.find((e) => e.type === "post.updated");
      expect(updated).toBeDefined();
      expect((updated?.data as { changed: string[] }).changed).toEqual(["text"]);
      // A caption edit is not a reschedule.
      expect(events.find((e) => e.type === "post.rescheduled")).toBeUndefined();
    });
  });

  it("clears media with an empty array, and keeps it when the field is omitted", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const { dispatcher, events } = captureDispatcher();
      const app = createApp({
        db: tx,
        publishEnqueuer: enqueuer,
        webhookDispatcher: dispatcher,
      });

      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        IN_AN_HOUR(),
        [{ kind: "image", url: "https://example.com/a.jpg" }],
      );

      // Omitting `media` keeps what is stored.
      let res = await patch(app, fixture.apiKey.plaintext, rowId, {
        text: "caption only",
      });
      expect(res.status).toBe(200);
      let [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.mediaRefs).toHaveLength(1);

      // An explicit empty array clears it.
      res = await patch(app, fixture.apiKey.plaintext, rowId, { media: [] });
      expect(res.status).toBe(200);
      [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.mediaRefs).toEqual([]);

      const changed = events
        .filter((e) => e.type === "post.updated")
        .map((e) => (e.data as { changed: string[] }).changed);
      expect(changed).toEqual([["text"], ["media"]]);
    });
  });

  it("preflights the edited caption against the account's platform", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        IN_AN_HOUR(),
      );

      // The seed account is Bluesky, which caps at 300 graphemes.
      const res = await patch(app, fixture.apiKey.plaintext, rowId, {
        text: "x".repeat(301),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("bluesky.text.max_graphemes");

      // A rejected edit must not partially apply.
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.text).toBe("scheduled");
    });
  });

  it("preflights media against the effective post, not the delta alone", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        IN_AN_HOUR(),
        [{ kind: "image", url: "https://example.com/a.jpg" }],
      );

      // Bluesky refuses images and video in the same record.
      const res = await patch(app, fixture.apiKey.plaintext, rowId, {
        media: [
          { kind: "image", url: "https://example.com/a.jpg" },
          { kind: "video", url: "https://example.com/b.mp4" },
        ],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("bluesky.media.image_video_exclusive");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.mediaRefs).toHaveLength(1);
    });
  });

  it("emits both events when one request changes the time and the content", async () => {
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

      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        IN_AN_HOUR(),
      );

      const newAt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
      const res = await patch(app, fixture.apiKey.plaintext, rowId, {
        text: "new copy",
        scheduledAt: newAt,
      });
      expect(res.status).toBe(200);

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.text).toBe("new copy");
      expect(row?.scheduledAt?.toISOString()).toBe(newAt);

      // The time moved, so the job is replaced.
      expect(removals).toContain(rowId);
      expect(calls).toHaveLength(2);

      // Independent facts, independently reported.
      expect(events.find((e) => e.type === "post.rescheduled")).toBeDefined();
      expect(events.find((e) => e.type === "post.updated")).toBeDefined();
    });
  });

  it("rejects a body with no editable field", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        IN_AN_HOUR(),
      );

      const res = await patch(app, fixture.apiKey.plaintext, rowId, {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("at least one");
    });
  });

  it("rolls the row back when the queue swap fails", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      // The POST that creates the post consumes the first enqueue; the
      // reschedule's replacement is the one that blows up.
      const { enqueuer, removals } = captureEnqueuer({ failEnqueueAfter: 1 });
      const { dispatcher, events } = captureDispatcher();
      const app = createApp({
        db: tx,
        publishEnqueuer: enqueuer,
        webhookDispatcher: dispatcher,
      });

      const at = IN_AN_HOUR();
      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        at,
      );

      const newAt = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
      const res = await patch(app, fixture.apiKey.plaintext, rowId, {
        text: "new copy",
        scheduledAt: newAt,
      });
      expect(res.status).toBe(500);

      // The row must not claim a time or a caption no job will honour.
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.text).toBe("scheduled");
      expect(row?.scheduledAt?.toISOString()).toBe(at);
      expect(row?.status).toBe("queued");

      expect(removals).toContain(rowId);
      // No success event may escape for a change that did not stick.
      expect(events.find((e) => e.type === "post.rescheduled")).toBeUndefined();
      expect(events.find((e) => e.type === "post.updated")).toBeUndefined();
    });
  });

  it("edits a post that carries media, so the jsonb compare-and-swap matches", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        IN_AN_HOUR(),
        [
          { kind: "image", url: "https://example.com/a.jpg" },
          { kind: "image", url: "https://example.com/b.jpg" },
        ],
      );

      // The CAS predicate pins mediaRefs. If the stored jsonb did not compare
      // equal to what the read handed back, every edit on a post carrying
      // media would 409 instead of applying — the false negative this guards.
      const res = await patch(app, fixture.apiKey.plaintext, rowId, {
        text: "caption beside untouched media",
      });
      expect(res.status).toBe(200);

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.text).toBe("caption beside untouched media");
      expect(row?.mediaRefs).toHaveLength(2);
    });
  });

  it("refuses to edit a post that is no longer queued", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const { rowId } = await createScheduled(
        app,
        fixture.apiKey.plaintext,
        fixture.accountId,
        IN_AN_HOUR(),
      );
      await tx
        .update(postsTable)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(postsTable.id, rowId));

      const res = await patch(app, fixture.apiKey.plaintext, rowId, {
        text: "too late",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("post.status");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, rowId));
      expect(row?.text).toBe("scheduled");
    });
  });
});
