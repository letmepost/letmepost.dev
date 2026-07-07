import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
import { apiKeys } from "../src/db/schema/api_keys.js";
import { seed } from "../src/db/seed.js";
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import { DrizzleProfilesRepository } from "../src/repositories/profiles.js";
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

const PINTEREST_BOARDS_URL = "https://api.pinterest.com/v5/boards";

function boardsHandler(items: { id: string; name: string }[]) {
  return http.get(PINTEREST_BOARDS_URL, () =>
    HttpResponse.json({ items }),
  );
}

describeIfDb("Pinterest default-board picker endpoints", () => {
  it("GET /v1/accounts/:id/pinterest/boards proxies /v5/boards + returns the current default", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-1",
        token: "pin-access-token",
        tokenMetadata: {
          defaultBoardId: "board-a",
          defaultBoardName: "Default board",
        },
      });

      server.use(
        boardsHandler([
          { id: "board-a", name: "Default board" },
          { id: "board-b", name: "Another board" },
        ]),
      );

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${account.id}/pinterest/boards`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { id: string; name: string }[];
        defaultBoardId: string | null;
      };
      expect(body.defaultBoardId).toBe("board-a");
      expect(body.data.map((b) => b.id)).toEqual(["board-a", "board-b"]);
    });
  });

  it("PATCH /v1/accounts/:id/pinterest/default-board updates tokenMetadata", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-2",
        token: "pin-access-token",
        tokenMetadata: {
          defaultBoardId: "board-a",
          defaultBoardName: "Default board",
        },
      });
      server.use(
        boardsHandler([
          { id: "board-a", name: "Default board" },
          { id: "board-b", name: "Another board" },
        ]),
      );

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${account.id}/pinterest/default-board`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          },
          body: JSON.stringify({ boardId: "board-b" }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        defaultBoardId: string | null;
        defaultBoardName: string | null;
      };
      expect(body.defaultBoardId).toBe("board-b");
      expect(body.defaultBoardName).toBe("Another board");

      const reloaded = await repo.findById(account.id);
      expect(
        (reloaded?.tokenMetadata as Record<string, unknown> | undefined)
          ?.defaultBoardId,
      ).toBe("board-b");
    });
  });

  it("PATCH 404s when boardId doesn't belong to the account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-3",
        token: "pin-access-token",
        tokenMetadata: {},
      });
      server.use(
        boardsHandler([{ id: "board-a", name: "Default board" }]),
      );

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${account.id}/pinterest/default-board`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          },
          body: JSON.stringify({ boardId: "board-not-yours" }),
        },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("not_found");
      expect(body.error.rule).toBe("pinterest.board.unknown");
    });
  });

  it("GET /v1/accounts surfaces pinterest.defaultBoard{Id,Name} on Pinterest rows", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const pin = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-7",
        displayName: "alice-pin",
        token: "pin-access-token",
        tokenMetadata: {
          defaultBoardId: "board-x",
          defaultBoardName: "Pins to share",
          // refreshToken should NOT leak into the public view.
          refreshToken: "should-not-appear",
        },
      });

      const app = createApp({ db: tx });
      const listRes = await app.request("/v1/accounts", {
        method: "GET",
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      const listBody = (await listRes.json()) as {
        data: Array<Record<string, unknown>>;
      };
      const found = listBody.data.find((a) => a.id === pin.id) as
        | { pinterest?: { defaultBoardId: string; defaultBoardName: string } }
        | undefined;
      expect(found?.pinterest?.defaultBoardId).toBe("board-x");
      expect(found?.pinterest?.defaultBoardName).toBe("Pins to share");
      expect(JSON.stringify(found)).not.toContain("should-not-appear");

      const detailRes = await app.request(`/v1/accounts/${pin.id}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      const detailBody = (await detailRes.json()) as Record<string, unknown>;
      expect(
        (
          detailBody as {
            pinterest?: { defaultBoardId: string };
          }
        ).pinterest?.defaultBoardId,
      ).toBe("board-x");
      expect(JSON.stringify(detailBody)).not.toContain("should-not-appear");
    });
  });

  it("non-Pinterest accounts don't get a `pinterest` extension on the public view", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const app = createApp({ db: tx });
      const res = await app.request(`/v1/accounts/${fixture.accountId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.platform).toBe("bluesky");
      expect("pinterest" in body).toBe(false);
    });
  });

  it("POST /v1/accounts/:id/pinterest/boards creates a board (and optionally sets it as default)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-create",
        token: "pin-access-token",
        tokenMetadata: {},
      });

      let receivedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(
          "https://api.pinterest.com/v5/boards",
          async ({ request }) => {
            receivedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(
              { id: "board-new", name: "Demo board", privacy: "PUBLIC" },
              { status: 201 },
            );
          },
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${account.id}/pinterest/boards`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          },
          body: JSON.stringify({
            name: "Demo board",
            privacy: "PUBLIC",
            setAsDefault: true,
          }),
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        name: string;
        defaultBoardId?: string;
      };
      expect(body.id).toBe("board-new");
      expect(body.defaultBoardId).toBe("board-new");
      expect(receivedBody).toMatchObject({
        name: "Demo board",
        privacy: "PUBLIC",
      });

      const reloaded = await repo.findById(account.id);
      expect(
        (reloaded?.tokenMetadata as Record<string, unknown> | undefined)
          ?.defaultBoardId,
      ).toBe("board-new");
    });
  });

  it("POST /boards with upsert: true returns the existing board on duplicate name", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-upsert",
        token: "pin-access-token",
        tokenMetadata: {},
      });
      // Pinterest pretends the board already exists, then returns it via
      // /v5/boards on the recovery list call.
      server.use(
        http.post("https://api.pinterest.com/v5/boards", () =>
          HttpResponse.json(
            { message: "Try a different name. You already have a board with this name!", code: 58 },
            { status: 409 },
          ),
        ),
        http.get("https://api.pinterest.com/v5/boards", () =>
          HttpResponse.json({
            items: [{ id: "board-existing", name: "letmepost test", privacy: "PUBLIC" }],
          }),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${account.id}/pinterest/boards`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          },
          body: JSON.stringify({
            name: "letmepost test",
            privacy: "PUBLIC",
            setAsDefault: true,
            upsert: true,
          }),
        },
      );
      // Upsert path returns 200 (we didn't create) — distinguishable from
      // 201 (fresh creation) for callers that care.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        existing?: boolean;
        defaultBoardId?: string;
      };
      expect(body.id).toBe("board-existing");
      expect(body.existing).toBe(true);
      expect(body.defaultBoardId).toBe("board-existing");

      // Default landed on the account row even though we adopted, not created.
      const reloaded = await repo.findById(account.id);
      expect(
        (reloaded?.tokenMetadata as Record<string, unknown> | undefined)
          ?.defaultBoardId,
      ).toBe("board-existing");
    });
  });

  it("POST /boards with upsert: true surfaces a clear ghost-duplicate error when Pinterest's state is inconsistent", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-ghost",
        token: "pin-access-token",
        tokenMetadata: {},
      });
      // Pinterest claims duplicate but lists no matching board (sandbox quirk).
      server.use(
        http.post("https://api.pinterest.com/v5/boards", () =>
          HttpResponse.json(
            { message: "You already have a board with this name!", code: 58 },
            { status: 409 },
          ),
        ),
        http.get("https://api.pinterest.com/v5/boards", () =>
          HttpResponse.json({ items: [] }),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${account.id}/pinterest/boards`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          },
          body: JSON.stringify({
            name: "phantom board",
            upsert: true,
          }),
        },
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("platform_rejected");
      expect(body.error.rule).toBe("pinterest.board.upsert_ghost");
    });
  });

  it("POST /boards surfaces Pinterest's duplicate-name error as platform_rejected", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-dup",
        token: "pin-access-token",
        tokenMetadata: {},
      });
      server.use(
        http.post("https://api.pinterest.com/v5/boards", () =>
          HttpResponse.json(
            { message: "Board name already exists", code: 130 },
            { status: 409 },
          ),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${account.id}/pinterest/boards`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          },
          body: JSON.stringify({ name: "Existing board" }),
        },
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as {
        error: { code: string; remediation?: string };
      };
      expect(body.error.code).toBe("platform_rejected");
      expect(body.error.remediation).toContain("unique");
    });
  });

  it("POST /boards rejects invalid privacy value at validation time", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const repo = new DrizzlePlatformAccountsRepository(tx);
      const account = await repo.create({
        organizationId: fixture.organizationId,
        profileId: fixture.profileId,
        platform: "pinterest",
        platformAccountId: "pin-user-bad",
        token: "pin-access-token",
        tokenMetadata: {},
      });

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${account.id}/pinterest/boards`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${fixture.apiKey.plaintext}`,
          },
          body: JSON.stringify({ name: "x", privacy: "BANANA" }),
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });
  });

  it("rejects requests against a non-Pinterest account with platform.mismatch", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      // The seed fixture's default account is Bluesky.
      const fixture = await seed(tx);
      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${fixture.accountId}/pinterest/boards`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { rule?: string };
      };
      expect(body.error.rule).toBe("platform.mismatch");
    });
  });

  /**
   * Create a sibling profile owning a Pinterest account, and mint a key
   * scoped to the seed's default profile. The scoped key must not be able to
   * act on (or even detect) the sibling's Pinterest account.
   */
  async function seedSiblingPinterest(
    tx: Awaited<ReturnType<typeof getTestDb>>["db"],
    fixture: Awaited<ReturnType<typeof seed>>,
  ) {
    const profileRepo = new DrizzleProfilesRepository(tx);
    const sibling = await profileRepo.create({
      organizationId: fixture.organizationId,
      name: "Sibling",
      slug: `sibling-${randomBytes(4).toString("hex")}`,
    });
    const accountRepo = new DrizzlePlatformAccountsRepository(tx);
    const siblingAccount = await accountRepo.create({
      organizationId: fixture.organizationId,
      profileId: sibling.id,
      platform: "pinterest",
      platformAccountId: "pin-sibling",
      token: "pin-access-token",
      tokenMetadata: { defaultBoardId: "board-a", defaultBoardName: "Default" },
    });

    // Key scoped to the DEFAULT profile (the one seed() owns), not the sibling.
    const scopedPlaintext = `lmp_test_${randomBytes(24).toString("base64url")}`;
    await tx.insert(apiKeys).values({
      organizationId: fixture.organizationId,
      profileId: fixture.profileId,
      name: "scoped-default",
      prefix: "lmp_test_",
      hashedKey: createHash("sha256").update(scopedPlaintext).digest("hex"),
      last4: scopedPlaintext.slice(-4),
      scopes: ["posts:read", "posts:write"],
    });

    return { siblingAccount, scopedPlaintext };
  }

  it("GET /:id/pinterest/boards 404s for a profile-scoped key on a sibling profile's account (no leak)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { siblingAccount, scopedPlaintext } = await seedSiblingPinterest(
        tx,
        fixture,
      );

      // No boards handler registered — a leak would reach Pinterest and MSW's
      // onUnhandledRequest:"error" would surface it; the 404 short-circuits.
      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${siblingAccount.id}/pinterest/boards`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${scopedPlaintext}` },
        },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("not_found");
      expect(body.error.rule).toBe("api_key.profile_scope");
    });
  });

  it("PATCH /:id/pinterest/default-board 404s for a profile-scoped key on a sibling profile's account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { siblingAccount, scopedPlaintext } = await seedSiblingPinterest(
        tx,
        fixture,
      );

      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${siblingAccount.id}/pinterest/default-board`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${scopedPlaintext}`,
          },
          body: JSON.stringify({ boardId: "board-a" }),
        },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { rule?: string } };
      expect(body.error.rule).toBe("api_key.profile_scope");
    });
  });

  it("GET /:id/pinterest/boards succeeds for an org-wide key on any profile's account", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const { siblingAccount } = await seedSiblingPinterest(tx, fixture);
      server.use(boardsHandler([{ id: "board-a", name: "Default" }]));

      // fixture.apiKey is org-wide (profileId NULL) → reaches the sibling.
      const app = createApp({ db: tx });
      const res = await app.request(
        `/v1/accounts/${siblingAccount.id}/pinterest/boards`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${fixture.apiKey.plaintext}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      expect(body.data.map((b) => b.id)).toEqual(["board-a"]);
    });
  });
});
