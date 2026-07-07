import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
import { member, organization, user } from "../src/db/schema/auth.js";
import { computeRefreshDelayMs } from "../src/platforms/_shared/refresh.js";
import {
  createDefaultTokenRefreshEnqueuer,
  jobIdFor,
  type TokenRefreshEnqueuer,
} from "../src/queue/refresh-enqueue.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

// Capture what the default enqueuer hands to BullMQ's `queue.add` without a
// running Redis. Only `getRefreshTokenQueue` is stubbed; every other export
// (types, other queue getters) keeps its real implementation.
const addSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/queue/queues.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/queue/queues.js")>();
  return {
    ...actual,
    getRefreshTokenQueue: () => ({ add: addSpy }),
  };
});

describe("computeRefreshDelayMs", () => {
  it("returns null when tokenExpiresAt is missing (no clock-driven refresh)", () => {
    expect(
      computeRefreshDelayMs({ tokenExpiresAt: null }, 60_000),
    ).toBeNull();
  });

  it("returns 0 when expiry is already inside the horizon", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const expiresIn1Min = new Date(now.getTime() + 60_000);
    expect(
      computeRefreshDelayMs({ tokenExpiresAt: expiresIn1Min }, 30 * 60_000, now),
    ).toBe(0);
  });

  it("returns (expiry - horizon - now) when expiry is beyond horizon", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const expiresIn2h = new Date(now.getTime() + 2 * 60 * 60_000);
    const horizon = 30 * 60_000; // 30 min
    const delay = computeRefreshDelayMs(
      { tokenExpiresAt: expiresIn2h },
      horizon,
      now,
    );
    expect(delay).toBe(2 * 60 * 60_000 - horizon);
  });

  it("clamps to 0 when expiry is in the past (expired-but-still-present)", () => {
    const now = new Date("2026-04-25T12:00:00Z");
    const expired = new Date(now.getTime() - 1_000);
    expect(
      computeRefreshDelayMs({ tokenExpiresAt: expired }, 30 * 60_000, now),
    ).toBe(0);
  });
});

describe("jobIdFor", () => {
  it("gives consecutive refresh occurrences distinct ids", () => {
    // Occurrence N (fires 13:30) then schedules N+1 (fires 15:00). Distinct
    // fire times MUST yield distinct ids — otherwise BullMQ dedups the
    // re-enqueue against the just-completed job and the chain dies.
    const acct = "acct-1";
    const fireN = Date.UTC(2026, 3, 25, 13, 30, 0);
    const fireNext = fireN + 90 * 60_000;
    expect(jobIdFor(acct, fireN)).not.toBe(jobIdFor(acct, fireNext));
  });

  it("collapses schedules targeting the same second to one id", () => {
    // A genuine duplicate of the SAME occurrence (same wake-up, differing only
    // by sub-second scheduling latency) must still dedup.
    const acct = "acct-1";
    const target = Date.UTC(2026, 3, 25, 13, 30, 0);
    expect(jobIdFor(acct, target + 250)).toBe(jobIdFor(acct, target + 700));
  });

  it("scopes the id to the account so different accounts never collide", () => {
    const target = Date.UTC(2026, 3, 25, 13, 30, 0);
    expect(jobIdFor("acct-a", target)).not.toBe(jobIdFor("acct-b", target));
  });

  it("never contains ':' (reserved by BullMQ as a key separator)", () => {
    expect(jobIdFor("acct-1", Date.UTC(2026, 3, 25, 13, 30, 0))).not.toContain(
      ":",
    );
  });
});

describe("createDefaultTokenRefreshEnqueuer: refresh-chain job ids", () => {
  const data = { platformAccountId: "acct-1", organizationId: "org-1" };

  afterEach(() => {
    addSpy.mockReset();
    vi.useRealTimers();
  });

  it("gives two consecutive re-enqueues for the same account distinct job ids", async () => {
    const enqueuer = createDefaultTokenRefreshEnqueuer();
    vi.useFakeTimers();

    // Occurrence N: scheduled now, fires ~90 min out.
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    await enqueuer.enqueue(data, { delayMs: 90 * 60_000 });

    // Occurrence N+1: scheduled from inside N once it runs (~90 min later),
    // with its own ~90-min delay. A stable per-account id would collide with
    // the still-present completed job from N and be silently dropped.
    vi.setSystemTime(new Date("2026-04-25T13:30:00.000Z"));
    await enqueuer.enqueue(data, { delayMs: 90 * 60_000 });

    const ids = addSpy.mock.calls.map(
      (call) => (call[2] as { jobId: string }).jobId,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("dedups a genuine duplicate of the same occurrence (same fire time)", async () => {
    const enqueuer = createDefaultTokenRefreshEnqueuer();
    vi.useFakeTimers();

    // Two schedulers compute the delay from the SAME expiry at slightly
    // different `now`s. `now + delay` reduces to the same absolute fire time,
    // so both resolve to one id and the occurrence isn't double-booked.
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    await enqueuer.enqueue(data, { delayMs: 90 * 60_000 }); // fires 13:30:00.000

    vi.setSystemTime(new Date("2026-04-25T12:00:00.300Z"));
    await enqueuer.enqueue(data, { delayMs: 90 * 60_000 - 300 }); // fires 13:30:00.000

    const ids = addSpy.mock.calls.map(
      (call) => (call[2] as { jobId: string }).jobId,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

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

function buildMockAccessJwt(expSecondsFromNow = 2 * 60 * 60): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function seedOrg(tx: Awaited<ReturnType<typeof getTestDb>>["db"]) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [u] = await tx
    .insert(user)
    .values({
      email: `ref+${suffix}@letmepost.test`,
      name: `Ref User ${suffix}`,
      emailVerified: true,
    })
    .returning();
  const [org] = await tx
    .insert(organization)
    .values({ name: `ref-org-${suffix}`, slug: `ref-${suffix}` })
    .returning();
  await tx
    .insert(member)
    .values({ organizationId: org!.id, userId: u!.id, role: "owner" });
  return { userId: u!.id, organizationId: org!.id };
}

describeIfDb("accounts: initial refresh scheduling on connect", () => {
  it("enqueues a delayed refresh job using the provider's expiringHorizonMs", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { userId, organizationId } = await seedOrg(tx);

      // Mock Bluesky createSession with an access JWT expiring ~2h out. The
      // provider's horizon is 30min, so the scheduler should compute a delay
      // of roughly 90min.
      server.use(
        http.post(
          "https://bsky.social/xrpc/com.atproto.server.createSession",
          () =>
            HttpResponse.json({
              accessJwt: buildMockAccessJwt(2 * 60 * 60),
              refreshJwt: "refresh-token",
              did: "did:plc:alice",
              handle: "alice.bsky.social",
            }),
        ),
      );

      const captured: Array<{
        data: { platformAccountId: string; organizationId: string };
        delayMs: number;
      }> = [];
      const stub: TokenRefreshEnqueuer = {
        async enqueue(data, opts) {
          captured.push({ data, delayMs: opts.delayMs });
        },
      };

      const app = createApp({
        db: tx,
        testSession: { userId, organizationId },
        refreshEnqueuer: stub,
      });

      const res = await app.request("/v1/accounts/connect/bluesky/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "alice.bsky.social",
          appPassword: "abcd-efgh-ijkl-mnop",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };

      expect(captured).toHaveLength(1);
      expect(captured[0]!.data.platformAccountId).toBe(body.id);
      expect(captured[0]!.data.organizationId).toBe(organizationId);
      // Horizon is 30 min; token lives 2h → delay should be between 80 and
      // 100 min to absorb clock jitter in the test harness.
      const minutes = captured[0]!.delayMs / 60_000;
      expect(minutes).toBeGreaterThan(80);
      expect(minutes).toBeLessThan(100);
    });
  });
});
