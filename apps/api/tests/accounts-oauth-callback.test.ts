import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { onError } from "../src/errors.js";
import { createAccountRoutes } from "../src/routes/accounts.js";
import { encodeOAuthState } from "../src/oauth/state.js";
import { organization } from "../src/db/schema/auth.js";
import { platformAccounts } from "../src/db/schema/platform_accounts.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

afterAll(async () => {
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

type CallbackSessionResolver = (
  headers: Headers,
) => Promise<{ organizationId: string } | null>;

async function seedOrg(
  tx: Awaited<ReturnType<typeof getTestDb>>["db"],
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [org] = await tx
    .insert(organization)
    .values({ name: `cb-org-${suffix}`, slug: `cb-${suffix}` })
    .returning();
  return org!.id;
}

function buildApp(
  tx: Awaited<ReturnType<typeof getTestDb>>["db"],
  resolveCallbackSession: CallbackSessionResolver,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("db", tx);
    await next();
  });
  app.route(
    "/v1/accounts",
    createAccountRoutes({
      resolveCallbackSession,
      refreshEnqueuer: { async enqueue() {} },
    }),
  );
  app.onError(onError);
  return app;
}

async function callback(
  app: ReturnType<typeof buildApp>,
  platform: string,
  state: string,
) {
  return app.request(
    `/v1/accounts/oauth/${platform}/callback?code=fake&state=${encodeURIComponent(
      state,
    )}`,
  );
}

describeIfDb("GET /v1/accounts/oauth/:platform/callback — CSRF session gate", () => {
  it("blocks account-linking CSRF when the session org differs from the state org", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const orgA = await seedOrg(tx);
      // Victim's browser carries a session for a DIFFERENT org than the
      // attacker-minted state (which points at org A).
      const app = buildApp(tx, async () => ({ organizationId: "other-org" }));
      const state = encodeOAuthState({
        organizationId: orgA,
        profileId: null,
        platform: "twitter",
      });

      const res = await callback(app, "twitter", state);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain(
        "connect_error=session_mismatch",
      );

      // The token exchange + persistence must never run for a mismatched org.
      const rows = await tx
        .select()
        .from(platformAccounts)
        .where(eq(platformAccounts.organizationId, orgA));
      expect(rows).toHaveLength(0);
    });
  });

  it("blocks when there is no session on the callback navigation", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const orgA = await seedOrg(tx);
      const app = buildApp(tx, async () => null);
      const state = encodeOAuthState({
        organizationId: orgA,
        profileId: null,
        platform: "twitter",
      });

      const res = await callback(app, "twitter", state);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain(
        "connect_error=session_mismatch",
      );

      const rows = await tx
        .select()
        .from(platformAccounts)
        .where(eq(platformAccounts.organizationId, orgA));
      expect(rows).toHaveLength(0);
    });
  });

  it("allows the flow past the gate when the session org matches the state org", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const orgA = await seedOrg(tx);
      const app = buildApp(tx, async () => ({ organizationId: orgA }));
      const state = encodeOAuthState({
        organizationId: orgA,
        profileId: null,
        platform: "twitter",
      });

      const res = await callback(app, "twitter", state);
      // The gate lets it through; Twitter's completeConnect then fails fast at
      // input validation (no PKCE verifier in this state, no network call), so
      // we get a non-session_mismatch connect_error redirect. Proving the gate
      // did NOT short-circuit is the point.
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).not.toContain("session_mismatch");
    });
  });
});
