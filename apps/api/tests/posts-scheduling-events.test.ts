import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { eq } from "drizzle-orm";
import type { WebhookEventType } from "@letmepost/schemas";
import { createApp } from "../src/app.js";
import { seed } from "../src/db/seed.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import type { PublishEnqueuer } from "../src/queue/enqueue.js";
import type { WebhookDispatcher } from "../src/webhooks/dispatch.js";
import type { PublishJobData } from "../src/queue/queues.js";
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

type CapturedEnqueue = { data: PublishJobData; delayMs: number | undefined };

function captureEnqueuer(): {
  enqueuer: PublishEnqueuer;
  calls: CapturedEnqueue[];
  removals: string[];
} {
  const calls: CapturedEnqueue[] = [];
  const removals: string[] = [];
  return {
    calls,
    removals,
    enqueuer: {
      async enqueue(data, opts) {
        calls.push({ data, delayMs: opts?.delayMs });
      },
      async remove(postId) {
        removals.push(postId);
      },
    },
  };
}

type CapturedEvent = {
  organizationId: string;
  type: WebhookEventType;
  data: unknown;
  requestId?: string;
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

function blueskyHappyHandlers(did = "did:plc:test") {
  return [
    http.post(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      () =>
        HttpResponse.json({
          accessJwt: "access",
          refreshJwt: "refresh",
          did,
          handle: "alice.bsky.social",
        }),
    ),
    http.post(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      () =>
        HttpResponse.json({
          uri: `at://${did}/app.bsky.feed.post/abcxyz`,
          cid: "bafy-mock",
        }),
    ),
  ];
}

describeIfDb("POST /v1/posts — scheduled path (Approach B hybrid)", () => {
  it("persists a queued post, schedules a delayed job, and dispatches post.queued", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer, calls } = captureEnqueuer();
      const { dispatcher, events } = captureDispatcher();

      const app = createApp({
        db: tx,
        publishEnqueuer: enqueuer,
        webhookDispatcher: dispatcher,
      });
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          account: { platform: "bluesky", id: fixture.accountId },
          text: "scheduled hello",
          scheduledAt: future,
        }),
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        id: string;
        status: string;
        platform: string;
        scheduledAt: string;
      };
      expect(body.status).toBe("queued");
      expect(body.platform).toBe("bluesky");
      expect(body.scheduledAt).toBe(future);

      // Row landed with queued status + scheduledAt.
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, body.id));
      expect(row?.status).toBe("queued");
      expect(row?.scheduledAt?.toISOString()).toBe(future);
      expect(row?.text).toBe("scheduled hello");

      // Enqueuer saw the job with a reasonable future delay.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.data.postId).toBe(body.id);
      expect(calls[0]!.data.organizationId).toBe(fixture.organizationId);
      expect(calls[0]!.delayMs).toBeGreaterThan(59 * 60 * 1000);
      expect(calls[0]!.delayMs).toBeLessThanOrEqual(60 * 60 * 1000);

      // post.queued event dispatched with id + platform + scheduledAt.
      const queued = events.find((e) => e.type === "post.queued");
      expect(queued).toBeDefined();
      expect(queued?.organizationId).toBe(fixture.organizationId);
      const qdata = queued?.data as {
        id: string;
        platform: string;
        scheduledAt: string;
      };
      expect(qdata.id).toBe(body.id);
      expect(qdata.platform).toBe("bluesky");
      expect(qdata.scheduledAt).toBe(future);
    });
  });

  it("rejects scheduledAt in the past with validation_failed", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { enqueuer, calls } = captureEnqueuer();
      const app = createApp({ db: tx, publishEnqueuer: enqueuer });

      const past = new Date(Date.now() - 60_000).toISOString();
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          account: { platform: "bluesky", id: fixture.accountId },
          text: "too late",
          scheduledAt: past,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; rule?: string } };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.rule).toBe("scheduledAt.future");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects scheduledAt combined with media until the scheduled-media slice lands", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const app = createApp({ db: tx });

      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          account: { platform: "bluesky", id: fixture.accountId },
          text: "with image",
          scheduledAt: future,
          media: [
            {
              kind: "image",
              url: "https://example.com/x.jpg",
              altText: "test",
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; rule?: string } };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.rule).toBe("scheduledAt.text_only");
    });
  });
});

describeIfDb("POST /v1/posts — immediate path event dispatch", () => {
  it("dispatches post.published on a successful immediate publish", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(...blueskyHappyHandlers());
      const { dispatcher, events } = captureDispatcher();

      const app = createApp({ db: tx, webhookDispatcher: dispatcher });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          account: { platform: "bluesky", id: fixture.accountId },
          text: "immediate hello",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        status: string;
        uri?: string;
        cid?: string;
      };
      expect(body.status).toBe("published");

      // Row landed as published.
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, body.id));
      expect(row?.status).toBe("published");
      expect(row?.platformCid).toBe("bafy-mock");

      // post.published dispatched.
      const published = events.find((e) => e.type === "post.published");
      expect(published).toBeDefined();
      const pdata = published?.data as {
        id: string;
        uri?: string;
        cid?: string;
      };
      expect(pdata.id).toBe(body.id);
      expect(pdata.cid).toBe("bafy-mock");
    });
  });

  it("dispatches post.rejected and marks the row rejected on platform_rejected", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json({
              accessJwt: "access",
              refreshJwt: "refresh",
              did: "did:plc:test",
              handle: "alice.bsky.social",
            }),
        ),
        http.post(
          "https://bsky.social/xrpc/com.atproto.repo.createRecord",
          () =>
            HttpResponse.json(
              { error: "InvalidRequest", message: "Record validation failed" },
              { status: 400 },
            ),
        ),
      );
      const { dispatcher, events } = captureDispatcher();

      const app = createApp({ db: tx, webhookDispatcher: dispatcher });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          account: { platform: "bluesky", id: fixture.accountId },
          text: "will be rejected",
        }),
      });

      expect(res.status).toBe(502);
      const errBody = (await res.json()) as { error: { code: string } };
      expect(errBody.error.code).toBe("platform_rejected");

      // post.rejected dispatched.
      const rejected = events.find((e) => e.type === "post.rejected");
      expect(rejected).toBeDefined();

      // Row is rejected and captures the error envelope.
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.organizationId, fixture.organizationId));
      expect(row?.status).toBe("rejected");
      expect((row?.error as { code?: string } | null)?.code).toBe(
        "platform_rejected",
      );
    });
  });
});
