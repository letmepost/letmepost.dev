import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { eq } from "drizzle-orm";
import { UnrecoverableError } from "bullmq";
import { seed } from "../src/db/seed.js";
import { posts as postsTable } from "../src/db/schema/posts.js";
import { LetmepostError } from "../src/errors.js";
import type { DrizzleClient } from "../src/db/index.js";
import type { WebhookDispatcher } from "../src/webhooks/dispatch.js";
import {
  processPublishJob,
  type PublishJobDeps,
  type PublishJobLike,
} from "../src/queue/publish-processor.js";
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

const BLUESKY_CREATE_SESSION =
  "https://bsky.social/xrpc/com.atproto.server.createSession";
const BLUESKY_CREATE_RECORD =
  "https://bsky.social/xrpc/com.atproto.repo.createRecord";

/** createSession + createRecord succeed → publisher returns uri/cid. */
function blueskyHappyHandlers(did = "did:plc:test") {
  return [
    http.post(BLUESKY_CREATE_SESSION, () =>
      HttpResponse.json({
        accessJwt: "access",
        refreshJwt: "refresh",
        did,
        handle: "alice.bsky.social",
      }),
    ),
    http.post(BLUESKY_CREATE_RECORD, () =>
      HttpResponse.json({
        uri: `at://${did}/app.bsky.feed.post/abcxyz`,
        cid: "bafy-mock",
      }),
    ),
  ];
}

/**
 * Network error on createSession → `platformFetch` catch → LetmepostError
 * `platform_unavailable`. This is the RETRYABLE class the processor's
 * catch-block treats specially (revert vs finalise depending on attempt).
 */
function blueskyUnavailableHandlers() {
  return [http.post(BLUESKY_CREATE_SESSION, () => HttpResponse.error())];
}

/**
 * 401 on createSession → `authFailed` → LetmepostError `platform_auth_failed`.
 * This is a PERMANENT class → the processor finalises + throws UnrecoverableError.
 */
function blueskyAuthFailedHandlers() {
  return [
    http.post(BLUESKY_CREATE_SESSION, () =>
      HttpResponse.json(
        {
          error: "AuthenticationRequired",
          message: "Invalid identifier or password",
        },
        { status: 401 },
      ),
    ),
  ];
}

interface CapturedEvent {
  type: string;
  organizationId: string;
  data: unknown;
}

function makeDeps(tx: DrizzleClient): {
  deps: PublishJobDeps;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const dispatcher: WebhookDispatcher = {
    async dispatch(params) {
      events.push({
        type: params.type,
        organizationId: params.organizationId,
        data: params.data,
      });
    },
  };
  const deps: PublishJobDeps = {
    db: tx,
    dispatcher,
    // Bluesky never enqueues a TikTok status-poll job; blow up loudly if the
    // processor ever reaches for it on this platform.
    getTikTokPollQueue: () => {
      throw new Error("getTikTokPollQueue must not be called for bluesky");
    },
  };
  return { deps, events };
}

async function seedPost(
  tx: DrizzleClient,
  args: {
    organizationId: string;
    accountId: string;
    status?: "queued" | "validated";
    text?: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(postsTable)
    .values({
      organizationId: args.organizationId,
      accountId: args.accountId,
      status: args.status ?? "validated",
      text: args.text ?? "scheduled hello",
    })
    .returning();
  if (!row) throw new Error("seedPost: failed to insert post row");
  return row;
}

function makeJob(
  data: { postId: string; organizationId: string; requestId?: string },
  attemptsMade: number,
  attempts: number,
): PublishJobLike {
  return { data, attemptsMade, opts: { attempts } };
}

async function readRow(
  tx: DrizzleClient,
  postId: string,
): Promise<{ status: string; error: Record<string, unknown> | null }> {
  const [row] = await tx
    .select()
    .from(postsTable)
    .where(eq(postsTable.id, postId))
    .limit(1);
  if (!row) throw new Error("readRow: post row disappeared");
  return { status: row.status, error: row.error };
}

async function capture(
  fn: () => Promise<unknown>,
): Promise<{ thrown: unknown }> {
  try {
    await fn();
    return { thrown: undefined };
  } catch (err) {
    return { thrown: err };
  }
}

describeIfDb("processPublishJob — retry / finalise logic", () => {
  it("retryable failure on a non-last attempt reverts the row to 'validated' and fires no failure event", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const post = await seedPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
      });
      server.use(...blueskyUnavailableHandlers());

      const { deps, events } = makeDeps(tx);
      const job = makeJob(
        { postId: post.id, organizationId: fixture.organizationId },
        0,
        3,
      );

      const { thrown } = await capture(() => processPublishJob(job, deps));

      // Rethrown as the raw retryable error (NOT wrapped) so BullMQ retries.
      expect(thrown).toBeInstanceOf(LetmepostError);
      expect(thrown).not.toBeInstanceOf(UnrecoverableError);
      expect((thrown as LetmepostError).code).toBe("platform_unavailable");

      // Row handed back to a re-attemptable state — NOT failed/rejected.
      const row = await readRow(tx, post.id);
      expect(row.status).toBe("validated");

      // No terminal lifecycle event before retries are exhausted.
      expect(events).toHaveLength(0);
      expect(events.some((e) => e.type === "post.failed")).toBe(false);
      expect(events.some((e) => e.type === "post.rejected")).toBe(false);
    });
  });

  it("retryable failure on the last attempt marks the row 'failed' and dispatches post.failed", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const post = await seedPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
      });
      server.use(...blueskyUnavailableHandlers());

      const { deps, events } = makeDeps(tx);
      // attemptsMade=2, attempts=3 → attemptsMade + 1 >= 3 → last attempt.
      const job = makeJob(
        { postId: post.id, organizationId: fixture.organizationId },
        2,
        3,
      );

      const { thrown } = await capture(() => processPublishJob(job, deps));

      // Still the raw error (last-attempt path re-throws `err`, not Unrecoverable).
      expect(thrown).toBeInstanceOf(LetmepostError);
      expect(thrown).not.toBeInstanceOf(UnrecoverableError);
      expect((thrown as LetmepostError).code).toBe("platform_unavailable");

      const row = await readRow(tx, post.id);
      expect(row.status).toBe("failed");
      expect(row.error?.code).toBe("platform_unavailable");

      expect(events.some((e) => e.type === "post.failed")).toBe(true);
      expect(events.some((e) => e.type === "post.rejected")).toBe(false);
    });
  });

  it("permanent (auth) failure marks the row 'rejected', dispatches post.rejected, and throws UnrecoverableError", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const post = await seedPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
      });
      server.use(...blueskyAuthFailedHandlers());

      const { deps, events } = makeDeps(tx);
      // First attempt — permanent errors finalise regardless of attempt count.
      const job = makeJob(
        { postId: post.id, organizationId: fixture.organizationId },
        0,
        3,
      );

      const { thrown } = await capture(() => processPublishJob(job, deps));

      expect(thrown).toBeInstanceOf(UnrecoverableError);

      const row = await readRow(tx, post.id);
      expect(row.status).toBe("rejected");
      expect(row.error?.code).toBe("platform_auth_failed");

      expect(events.some((e) => e.type === "post.rejected")).toBe(true);
      expect(events.some((e) => e.type === "post.failed")).toBe(false);
    });
  });

  it("happy path publishes the row and dispatches post.published", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const post = await seedPost(tx, {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
      });
      server.use(...blueskyHappyHandlers());

      const { deps, events } = makeDeps(tx);
      const job = makeJob(
        {
          postId: post.id,
          organizationId: fixture.organizationId,
          requestId: "req-happy",
        },
        0,
        3,
      );

      const result = (await processPublishJob(job, deps)) as {
        ok?: boolean;
        uri?: string;
        cid?: string;
      };
      expect(result.ok).toBe(true);
      expect(result.uri).toMatch(/^at:\/\//);
      expect(result.cid).toBe("bafy-mock");

      const row = await readRow(tx, post.id);
      expect(row.status).toBe("published");

      const published = events.find((e) => e.type === "post.published");
      expect(published).toBeDefined();
      expect(published!.organizationId).toBe(fixture.organizationId);
      const data = published!.data as { id: string; platform: string };
      expect(data.id).toBe(post.id);
      expect(data.platform).toBe("bluesky");
      expect(events.some((e) => e.type === "post.failed")).toBe(false);
      expect(events.some((e) => e.type === "post.rejected")).toBe(false);
    });
  });
});
