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
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import type { WebhookDispatcher } from "../src/webhooks/dispatch.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";
import type { DrizzleClient } from "../src/db/index.js";

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

async function seedWithTwitter(tx: DrizzleClient) {
  const fixture = await seed(tx);
  const repo = new DrizzlePlatformAccountsRepository(tx);
  const account = await repo.create({
    organizationId: fixture.organizationId,
    profileId: fixture.profileId,
    platform: "twitter",
    platformAccountId: "twitter-user-1",
    displayName: "twitter-user-1",
    token: "access-token-xyz",
    tokenMetadata: { username: "alice" },
  });
  return { fixture, account };
}

describeIfDb("POST /v1/posts (twitter)", () => {
  it("publishes a text tweet, marks row published, dispatches post.published", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithTwitter(tx);
      server.use(
        http.post("https://api.twitter.com/2/tweets", () =>
          HttpResponse.json({ data: { id: "1700000001", text: "hello" } }),
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
          targets: [{ accountId: account.id }],
          text: "hello",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        status: string;
        results: Array<{
          platform: string;
          status: string;
          postId?: string;
          uri?: string;
        }>;
      };
      expect(body.status).toBe("published");
      const result = body.results[0]!;
      expect(result.platform).toBe("twitter");
      expect(result.status).toBe("published");
      expect(result.uri).toContain("twitter.com");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.id, result.postId!));
      expect(row?.status).toBe("published");
      expect(events.some((e) => e.type === "post.published")).toBe(true);
    });
  });

  it("marks row rejected + emits post.rejected on X auth failure (401)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithTwitter(tx);
      server.use(
        http.post("https://api.twitter.com/2/tweets", () =>
          HttpResponse.json(
            { title: "Unauthorized", status: 401, detail: "bad token" },
            { status: 401 },
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
          targets: [{ accountId: account.id }],
          text: "unauthorized path",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ status: string; error?: { code: string } }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("platform_auth_failed");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.organizationId, fixture.organizationId));
      expect(row?.status).toBe("rejected");
      expect(events.some((e) => e.type === "post.rejected")).toBe(true);
    });
  });

  it("marks row rejected + emits post.rejected on a duplicate-tweet error (code 187)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithTwitter(tx);
      server.use(
        http.post("https://api.twitter.com/2/tweets", () =>
          HttpResponse.json(
            {
              errors: [
                { code: 187, message: "Status is a duplicate." },
              ],
            },
            { status: 403 },
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
          targets: [{ accountId: account.id }],
          text: "a duplicate tweet",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; remediation?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("platform_rejected");
      expect(result.error!.remediation).toContain("duplicate");

      expect(events.some((e) => e.type === "post.rejected")).toBe(true);
    });
  });

  it("fails preflight (no upstream call) for a tweet over 280 graphemes", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithTwitter(tx);
      // No MSW handlers — any upstream call would fail the test.
      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: account.id }],
          text: "a".repeat(281),
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("preflight_failed");
      expect(body.error.rule).toBe("twitter.text.max_graphemes");

      // Atomic preflight runs before any post row is persisted, so a batch
      // rejected at preflight leaves no row behind (no upstream call, nothing
      // to record as rejected).
      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.organizationId, fixture.organizationId));
      expect(row).toBeUndefined();
    });
  });

  it("uploads video via INIT/APPEND/FINALIZE/STATUS chunked path and tweets", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithTwitter(tx);
      // 6 MB of zeros — larger than the 4 MB chunk size, so we'll see
      // exactly two APPEND calls.
      const videoBytes = new Uint8Array(6 * 1024 * 1024);
      const calls = {
        init: 0,
        append: 0,
        finalize: 0,
        status: 0,
      };
      server.use(
        // INIT, APPEND, FINALIZE all hit the same URL with different
        // `command` values. Branch in the handler so we can assert each
        // ran.
        http.post(
          "https://upload.twitter.com/1.1/media/upload.json",
          async ({ request }) => {
            const ct = request.headers.get("content-type") ?? "";
            if (ct.includes("multipart/form-data")) {
              calls.append += 1;
              return new HttpResponse(null, { status: 204 });
            }
            const text = await request.text();
            const params = new URLSearchParams(text);
            const command = params.get("command");
            if (command === "INIT") {
              calls.init += 1;
              return HttpResponse.json({ media_id_string: "vid-1234" });
            }
            if (command === "FINALIZE") {
              calls.finalize += 1;
              return HttpResponse.json({
                media_id_string: "vid-1234",
                processing_info: {
                  state: "in_progress",
                  check_after_secs: 1,
                  progress_percent: 30,
                },
              });
            }
            return HttpResponse.json(
              { error: `unknown command: ${command}` },
              { status: 400 },
            );
          },
        ),
        http.get(
          "https://upload.twitter.com/1.1/media/upload.json",
          () => {
            calls.status += 1;
            return HttpResponse.json({
              media_id_string: "vid-1234",
              processing_info: {
                state: "succeeded",
                progress_percent: 100,
              },
            });
          },
        ),
        http.post("https://api.twitter.com/2/tweets", () =>
          HttpResponse.json({
            data: { id: "1700000099", text: "video tweet" },
          }),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: account.id }],
          text: "video tweet",
          media: [
            {
              kind: "video",
              bytesBase64: Buffer.from(videoBytes).toString("base64"),
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(calls.init).toBe(1);
      // 6 MB / 4 MB chunk size → 2 APPEND calls (4 MB + 2 MB).
      expect(calls.append).toBe(2);
      expect(calls.finalize).toBe(1);
      // FINALIZE returned in_progress → at least one STATUS poll.
      expect(calls.status).toBeGreaterThanOrEqual(1);
    });
  });

  it("surfaces a failed video transcode as platform_rejected with a remediation", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithTwitter(tx);
      const videoBytes = new Uint8Array(1024); // tiny — single APPEND.
      server.use(
        http.post(
          "https://upload.twitter.com/1.1/media/upload.json",
          async ({ request }) => {
            const ct = request.headers.get("content-type") ?? "";
            if (ct.includes("multipart/form-data")) {
              return new HttpResponse(null, { status: 204 });
            }
            const text = await request.text();
            const params = new URLSearchParams(text);
            const command = params.get("command");
            if (command === "INIT") {
              return HttpResponse.json({ media_id_string: "vid-fail" });
            }
            if (command === "FINALIZE") {
              return HttpResponse.json({
                media_id_string: "vid-fail",
                processing_info: {
                  state: "failed",
                  error: {
                    code: 3,
                    name: "InvalidMedia",
                    message: "The video is invalid.",
                  },
                },
              });
            }
            return HttpResponse.json({}, { status: 400 });
          },
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: account.id }],
          text: "bad video",
          media: [
            {
              kind: "video",
              bytesBase64: Buffer.from(videoBytes).toString("base64"),
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; rule?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("platform_rejected");
      expect(result.error!.rule).toBe("twitter.media.video_processing_failed");
    });
  });

  it("marks row failed + emits post.failed on a 429 rate limit (retryable → platform_unavailable)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithTwitter(tx);
      server.use(
        http.post("https://api.twitter.com/2/tweets", () =>
          HttpResponse.json(
            { title: "Too Many Requests", detail: "rate limit exceeded" },
            { status: 429 },
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
          targets: [{ accountId: account.id }],
          text: "rate limited path",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ status: string; error?: { code: string } }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      // 429 is transient — NOT rejected. The row is "failed" (retryable) so
      // a momentary throttle doesn't permanently drop the scheduled post.
      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("platform_unavailable");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.organizationId, fixture.organizationId));
      expect(row?.status).toBe("failed");
      expect(events.some((e) => e.type === "post.failed")).toBe(true);
      expect(events.some((e) => e.type === "post.rejected")).toBe(false);
    });
  });

  it("marks row failed + emits post.failed when X is unreachable (network error)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithTwitter(tx);
      server.use(
        http.post("https://api.twitter.com/2/tweets", () =>
          HttpResponse.error(),
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
          targets: [{ accountId: account.id }],
          text: "network dies",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ status: string; error?: { code: string } }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("platform_unavailable");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.organizationId, fixture.organizationId));
      expect(row?.status).toBe("failed");
      expect(events.some((e) => e.type === "post.failed")).toBe(true);
    });
  });
});
