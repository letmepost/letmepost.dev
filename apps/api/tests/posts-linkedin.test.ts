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
import type { DrizzleClient } from "../src/db/index.js";
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

async function seedWithLinkedIn(tx: DrizzleClient) {
  const fixture = await seed(tx);
  const repo = new DrizzlePlatformAccountsRepository(tx);
  const account = await repo.create({
    organizationId: fixture.organizationId,
    profileId: fixture.profileId,
    platform: "linkedin",
    platformAccountId: "ABCDEF123",
    displayName: "Alice Anderson",
    token: "li-access-token",
    tokenMetadata: { authorUrn: "urn:li:person:ABCDEF123" },
  });
  return { fixture, account };
}

describeIfDb("POST /v1/posts (linkedin)", () => {
  it("publishes a text post, marks row published, dispatches post.published with profileId", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithLinkedIn(tx);

      let capturedHeaders: Headers | null = null;
      server.use(
        http.post("https://api.linkedin.com/rest/posts", ({ request }) => {
          capturedHeaders = request.headers;
          return new HttpResponse(null, {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:7000000001" },
          });
        }),
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
          text: "Hello from letmepost.dev",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ platform: string; uri?: string; status: string }>;
      };
      expect(body.results[0]!.uri).toBe("urn:li:share:7000000001");
      expect(body.results[0]!.status).toBe("published");

      // Version pinning: every Versioned-API call MUST carry `LinkedIn-Version`.
      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!.get("linkedin-version")).toMatch(/^\d{6}$/);
      expect(capturedHeaders!.get("x-restli-protocol-version")).toBe("2.0.0");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.accountId, account.id));
      expect(row?.status).toBe("published");
      expect(row?.platformUri).toBe("urn:li:share:7000000001");

      const published = events.find((e) => e.type === "post.published");
      expect(published).toBeDefined();
      const data = published!.data as { profileId: string; platform: string };
      expect(data.profileId).toBe(fixture.profileId);
      expect(data.platform).toBe("linkedin");
    });
  });

  it("rejects text > 3000 graphemes via preflight (no upstream call)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithLinkedIn(tx);

      let upstreamCalls = 0;
      server.use(
        http.post("https://api.linkedin.com/rest/posts", () => {
          upstreamCalls += 1;
          return new HttpResponse(null, { status: 201 });
        }),
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
          text: "a".repeat(3001),
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("linkedin.text.max_graphemes");
      expect(upstreamCalls).toBe(0);
    });
  });

  it("maps 401 INVALID_TOKEN to platform_auth_failed → post.rejected", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithLinkedIn(tx);
      server.use(
        http.post("https://api.linkedin.com/rest/posts", () =>
          HttpResponse.json(
            { code: "INVALID_TOKEN", message: "Invalid access token" },
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
          text: "should fail upstream",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ status: string; error?: { code: string } }>;
      };
      expect(body.results[0]!.status).toBe("rejected");
      expect(body.results[0]!.error!.code).toBe("platform_auth_failed");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.accountId, account.id));
      expect(row?.status).toBe("rejected");
      expect(events.some((e) => e.type === "post.rejected")).toBe(true);
    });
  });

  it("maps 429 to platform_unavailable (retryable) → row failed + post.failed", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithLinkedIn(tx);
      server.use(
        http.post("https://api.linkedin.com/rest/posts", () =>
          HttpResponse.json(
            { message: "Request exceeded rate limit" },
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
      // 429 is transient — NOT rejected. The row is "failed" (retryable) so a
      // momentary throttle doesn't permanently drop the scheduled post.
      expect(body.results[0]!.status).toBe("failed");
      expect(body.results[0]!.error!.code).toBe("platform_unavailable");

      const [row] = await tx
        .select()
        .from(postsTable)
        .where(eq(postsTable.accountId, account.id));
      expect(row?.status).toBe("failed");
      expect(events.some((e) => e.type === "post.failed")).toBe(true);
      expect(events.some((e) => e.type === "post.rejected")).toBe(false);
    });
  });

  it("maps 422 INVALID_AUTHOR to platform_rejected with URN remediation", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithLinkedIn(tx);
      server.use(
        http.post("https://api.linkedin.com/rest/posts", () =>
          HttpResponse.json(
            {
              code: "INVALID_AUTHOR",
              message: "Author urn:li:person:WRONG is not allowed",
            },
            { status: 422 },
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
          targets: [{ accountId: account.id }],
          text: "Hello",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{
          status: string;
          error?: { code: string; remediation?: string };
        }>;
      };
      expect(body.results[0]!.status).toBe("rejected");
      expect(body.results[0]!.error!.code).toBe("platform_rejected");
      expect(body.results[0]!.error!.remediation).toMatch(/urn|MDP/i);
    });
  });

  it("returns ambiguous error if 201 but missing x-restli-id (loud-failure)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { fixture, account } = await seedWithLinkedIn(tx);
      server.use(
        http.post("https://api.linkedin.com/rest/posts", () =>
          new HttpResponse(null, { status: 201 }),
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
          text: "ambiguous response",
        }),
      });
      // The publisher throws platform_rejected with an "ambiguous" message
      // rather than fabricating an id — silent-success is the failure mode
      // we exist to prevent. The batch envelope returns 200; the loud failure
      // surfaces inside results[0].
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{
          status: string;
          error?: { code: string; message?: string };
        }>;
      };
      expect(body.results[0]!.status).toBe("rejected");
      expect(body.results[0]!.error!.code).toBe("platform_rejected");
      expect(body.results[0]!.error!.message).toMatch(/ambiguous|x-restli-id/i);
    });
  });

  it("rejects org URNs at preflight (MDP follow-up slice)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      // simulate someone with an org URN stored (e.g. via a future migration
      // path) — preflight should still refuse it in this MVP slice.
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "linkedin",
        platformAccountId: "1234",
        displayName: "Acme Corp",
        token: "li-access-token",
        tokenMetadata: { authorUrn: "urn:li:organization:1234" },
      });

      let upstreamCalls = 0;
      server.use(
        http.post("https://api.linkedin.com/rest/posts", () => {
          upstreamCalls += 1;
          return new HttpResponse(null, { status: 201 });
        }),
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
          text: "Org post — should fail",
        }),
      });
      // Author-URN validation is a deep per-target preflight check that runs
      // inside the publisher before any network call — so it surfaces inside
      // results[0] on a 200 batch ack, never reaching upstream.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ status: string; error?: { code: string; rule?: string } }>;
      };
      expect(body.results[0]!.status).toBe("rejected");
      expect(body.results[0]!.error!.code).toBe("preflight_failed");
      expect(body.results[0]!.error!.rule).toBe(
        "linkedin.author.org_not_supported",
      );
      expect(upstreamCalls).toBe(0);
    });
  });
});
