import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../src/app.js";
import { auth } from "../src/auth.js";
import { isAllowedOrigin } from "../src/middleware/origin-guard.js";
import { seed } from "../src/db/seed.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

afterAll(async () => {
  await closeTestDb();
});

// Stand in for the real better-auth cookie lookup so we can drive the
// session-cookie branch of apiKeyOrSession() without a live session (the
// real getSession hits its own DB singleton, invisible to the per-test tx).
type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>;
function stubSession(orgId: string, userId: string) {
  return vi.spyOn(auth.api, "getSession").mockResolvedValue({
    session: { id: "test-session", activeOrganizationId: orgId },
    user: { id: userId },
  } as unknown as SessionResult);
}

describe("origin helper", () => {
  const prev = process.env.TRUSTED_ORIGINS;
  beforeAll(() => {
    process.env.TRUSTED_ORIGINS = "https://dashboard.letmepost.dev";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.TRUSTED_ORIGINS;
    else process.env.TRUSTED_ORIGINS = prev;
  });

  it("accepts the dev dashboard and configured trusted origins", () => {
    expect(isAllowedOrigin("http://localhost:3001")).toBe(true);
    expect(isAllowedOrigin("https://dashboard.letmepost.dev")).toBe(true);
  });

  it("rejects unknown origins and null", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin(null)).toBe(false);
  });
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

describeIfDb("CSRF guard on session-cookie mutations (POST /v1/posts)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a session-cookie POST with a disallowed Origin (403)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      stubSession(fixture.organizationId, fixture.userId);
      const app = createApp({ db: tx });

      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ targets: [{ platform: "twitter" }], text: "x" }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });
  });

  it("rejects a session-cookie POST with a missing Origin (403)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      stubSession(fixture.organizationId, fixture.userId);
      const app = createApp({ db: tx });

      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: [{ platform: "twitter" }], text: "x" }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });
  });

  it("passes a session-cookie POST with the dashboard Origin to the handler", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      stubSession(fixture.organizationId, fixture.userId);
      const app = createApp({ db: tx });

      // Allowed Origin clears the CSRF gate; the handler then rejects the
      // empty targets[] as a 400 — proving control reached it, not a 403.
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3001",
        },
        body: JSON.stringify({ targets: [] }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });
  });

  it("does NOT block a Bearer-API-key POST that sends no Origin", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      // No session stub — this must resolve via the Bearer path only.
      const app = createApp({ db: tx });

      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({ targets: [] }),
      });

      // Reaches the handler (400 on empty targets) rather than tripping the
      // 403 CSRF gate — the Bearer path is exempt from the origin check.
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });
  });
});
