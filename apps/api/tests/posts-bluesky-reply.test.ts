import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
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

const describeIfDb = canRunDbTests ? describe : describe.skip;

function captureCreateRecord(into: { reply?: unknown }) {
  return [
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
      async ({ request }) => {
        const body = (await request.json()) as { record?: { reply?: unknown } };
        into.reply = body.record?.reply;
        return HttpResponse.json({
          uri: "at://did:plc:test/app.bsky.feed.post/new",
          cid: "bafy-new",
        });
      },
    ),
  ];
}

describeIfDb("POST /v1/posts (bluesky reply threading)", () => {
  it("sets reply.root + reply.parent from replyToUri/replyToCid (root defaults to parent)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const captured: { reply?: unknown } = {};
      server.use(...captureCreateRecord(captured));

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [
            {
              accountId: fixture.accountId,
              options: {
                platform: "bluesky",
                replyToUri: "at://did:plc:test/app.bsky.feed.post/parent",
                replyToCid: "bafy-parent",
              },
            },
          ],
          text: "2/ continuing the thread",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Array<{ status: string }> };
      expect(body.results[0]!.status).toBe("published");
      expect(captured.reply).toEqual({
        root: { uri: "at://did:plc:test/app.bsky.feed.post/parent", cid: "bafy-parent" },
        parent: { uri: "at://did:plc:test/app.bsky.feed.post/parent", cid: "bafy-parent" },
      });
    });
  });

  it("uses an explicit replyRoot when provided (deeper thread)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const captured: { reply?: unknown } = {};
      server.use(...captureCreateRecord(captured));

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [
            {
              accountId: fixture.accountId,
              options: {
                platform: "bluesky",
                replyToUri: "at://did:plc:test/app.bsky.feed.post/p2",
                replyToCid: "bafy-p2",
                replyRootUri: "at://did:plc:test/app.bsky.feed.post/root",
                replyRootCid: "bafy-root",
              },
            },
          ],
          text: "3/ deeper in the thread",
        }),
      });

      expect(res.status).toBe(200);
      expect(captured.reply).toEqual({
        root: { uri: "at://did:plc:test/app.bsky.feed.post/root", cid: "bafy-root" },
        parent: { uri: "at://did:plc:test/app.bsky.feed.post/p2", cid: "bafy-p2" },
      });
    });
  });

  it("rejects replyToUri without replyToCid with validation_failed", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [
            {
              accountId: fixture.accountId,
              options: {
                platform: "bluesky",
                replyToUri: "at://did:plc:test/app.bsky.feed.post/parent",
              },
            },
          ],
          text: "missing the cid",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });
  });
});
