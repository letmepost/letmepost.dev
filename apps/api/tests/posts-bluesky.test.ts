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
import { createApp } from "../src/app.js";
import { seed } from "../src/db/seed.js";
import { apiKeys } from "../src/db/schema/api_keys.js";
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

describeIfDb("POST /v1/posts (bluesky, stored account)", () => {
  it("publishes a valid post with Bearer key + stored account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(...blueskyHappyHandlers());

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "Hello from letmepost.dev",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ platform: string; uri?: string; cid?: string }>;
      };
      expect(body.status).toBe("published");
      expect(body.results[0]!.platform).toBe("bluesky");
      expect(body.results[0]!.uri).toMatch(/^at:\/\//);
      expect(body.results[0]!.cid).toBe("bafy-mock");
    });
  });

  it("rejects missing Authorization header with unauthenticated", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: {
            platform: "bluesky",
            id: "00000000-0000-0000-0000-000000000000",
          },
          text: "nope",
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthenticated");
    });
  });

  it("rejects malformed API key prefix", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer not_a_real_key",
        },
        body: JSON.stringify({
          account: {
            platform: "bluesky",
            id: "00000000-0000-0000-0000-000000000000",
          },
          text: "nope",
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthenticated");
    });
  });

  it("rejects revoked API key", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, fixture.apiKey.id));

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          account: { platform: "bluesky", id: fixture.accountId },
          text: "nope",
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthenticated");
    });
  });

  it("returns not_found when the account belongs to a different org", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixtureA = await seed(tx);
      const fixtureB = await seed(tx);

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixtureB.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixtureA.accountId }],
          text: "should not publish",
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    });
  });

  it("returns validation_failed for missing account in body", async () => {
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
        body: JSON.stringify({ text: "no account" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });
  });

  it("returns preflight_failed for empty text", async () => {
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
          targets: [{ accountId: fixture.accountId }],
          text: "   ",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("preflight_failed");
      expect(body.error.rule).toBe("bluesky.text.non_empty");
    });
  });

  it("returns preflight_failed when text exceeds 300 graphemes", async () => {
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
          targets: [{ accountId: fixture.accountId }],
          text: "a".repeat(301),
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("preflight_failed");
      expect(body.error.rule).toBe("bluesky.text.max_graphemes");
    });
  });

  it("surfaces Bluesky auth failure as platform_auth_failed", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json(
              {
                error: "AuthenticationRequired",
                message: "Invalid identifier or password",
              },
              { status: 401 },
            ),
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
          targets: [{ accountId: fixture.accountId }],
          text: "test",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          platform: string;
          status: string;
          error?: {
            code: string;
            platformResponse?: unknown;
            remediation?: string;
          };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.platform).toBe("bluesky");
      expect(result.error!.code).toBe("platform_auth_failed");
      expect(result.error!.platformResponse).toMatchObject({
        error: "AuthenticationRequired",
      });
      expect(result.error!.remediation).toContain("app password");
    });
  });

  it("surfaces Bluesky createPost failure as platform_rejected with raw body", async () => {
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
              {
                error: "InvalidRequest",
                message: "Record validation failed",
              },
              { status: 400 },
            ),
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
          targets: [{ accountId: fixture.accountId }],
          text: "test",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          platform: string;
          status: string;
          error?: {
            code: string;
            platformResponse?: unknown;
            message?: string;
          };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.platform).toBe("bluesky");
      expect(result.error!.code).toBe("platform_rejected");
      expect(result.error!.platformResponse).toMatchObject({
        error: "InvalidRequest",
        message: "Record validation failed",
      });
      expect(result.error!.message).toContain("Record validation failed");
    });
  });
});
