import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { DrizzleClient } from "../src/db/index.js";
import { organization } from "../src/db/schema/auth.js";
import { DrizzlePlatformAccountsRepository } from "../src/repositories/platform-accounts.js";
import { DrizzleProfilesRepository } from "../src/repositories/profiles.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

const SECRET = "fb_app_secret_test_for_callback";

function base64Url(buf: Buffer | string): string {
  return (typeof buf === "string" ? Buffer.from(buf, "utf8") : buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeSignedRequest(
  payload: Record<string, unknown>,
  secret = SECRET,
): string {
  const encodedPayload = base64Url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(encodedPayload).digest();
  return `${base64Url(sig)}.${encodedPayload}`;
}

describe("POST /data-deletion/meta", () => {
  let savedSecret: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.META_APP_SECRET;
    savedBaseUrl = process.env.PUBLIC_API_BASE_URL;
    process.env.META_APP_SECRET = SECRET;
    process.env.PUBLIC_API_BASE_URL = "https://api.letmepost.dev";
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = savedSecret;
    if (savedBaseUrl === undefined) delete process.env.PUBLIC_API_BASE_URL;
    else process.env.PUBLIC_API_BASE_URL = savedBaseUrl;
  });

  it("returns the Meta-required JSON shape on a valid signed_request", async () => {
    const app = createApp();
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "fb_user_42",
      issued_at: 1746000000,
    });
    const body = new URLSearchParams({ signed_request: sr });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      url: string;
      confirmation_code: string;
    };
    expect(json.url).toMatch(
      /^https:\/\/api\.letmepost\.dev\/data-deletion\/status\?code=lmp_/,
    );
    expect(json.confirmation_code).toMatch(/^lmp_/);
  });

  it("also accepts JSON bodies (test fixtures)", async () => {
    const app = createApp();
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "fb_user_42",
    });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed_request: sr }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 if signed_request is missing", async () => {
    const app = createApp();
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "signed_request_missing" });
  });

  it("returns 400 if signed_request is signed with the wrong secret", async () => {
    const app = createApp();
    const sr = makeSignedRequest(
      { algorithm: "HMAC-SHA256", user_id: "fb_user_42" },
      "wrong_secret",
    );
    const body = new URLSearchParams({ signed_request: sr });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "signed_request_invalid" });
  });

  it("returns 503 when META_APP_SECRET is not configured", async () => {
    delete process.env.META_APP_SECRET;
    const app = createApp();
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "fb_user_42",
    });
    const body = new URLSearchParams({ signed_request: sr });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /data-deletion/status", () => {
  it("renders an HTML page with the confirmation code", async () => {
    const app = createApp();
    const res = await app.request("/data-deletion/status?code=lmp_abc123");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Data deletion request");
    expect(body).toContain("lmp_abc123");
  });

  it("html-escapes the code query param", async () => {
    const app = createApp();
    const res = await app.request(
      `/data-deletion/status?code=${encodeURIComponent("<script>alert(1)</script>")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

/**
 * Regression coverage for the compliance no-op: the callback must delete the
 * platform_accounts rows whose stored app-scoped Meta user id (tokenMetadata
 * .metaUserId) equals the signed_request `user_id`. Matching against
 * platformAccountId — which holds a per-product resource id (Page id, IG user
 * id, Threads user id), never the app-scoped user id — silently deleted
 * nothing while still returning a 200 confirmation.
 */
describeIfDb("POST /data-deletion/meta — row removal (integration)", () => {
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = SECRET;
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = savedSecret;
  });
  afterAll(async () => {
    await closeTestDb();
  });

  async function seedOrgAndProfile(tx: DrizzleClient) {
    const [org] = await tx
      .insert(organization)
      .values({ name: "Acme", slug: `acme-${Date.now()}-${Math.random()}` })
      .returning();
    const profile = await new DrizzleProfilesRepository(tx).create({
      organizationId: org!.id,
      name: "Default",
      slug: "default",
    });
    return { organizationId: org!.id, profileId: profile.id };
  }

  async function seedAccount(
    tx: DrizzleClient,
    opts: {
      organizationId: string;
      profileId: string;
      platform: "facebook" | "instagram" | "threads";
      platformAccountId: string;
      metaUserId: string;
    },
  ) {
    return new DrizzlePlatformAccountsRepository(tx).create({
      organizationId: opts.organizationId,
      profileId: opts.profileId,
      platform: opts.platform,
      platformAccountId: opts.platformAccountId,
      token: "tok",
      tokenMetadata: { metaUserId: opts.metaUserId },
    });
  }

  function post(app: ReturnType<typeof createApp>, userId: string) {
    const sr = makeSignedRequest({ algorithm: "HMAC-SHA256", user_id: userId });
    return app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: sr }).toString(),
    });
  }

  it("deletes every Meta-family row for the matching app-scoped user, sparing others", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { organizationId, profileId } = await seedOrgAndProfile(tx);

      // Same real user across all three Meta products — the per-product
      // platformAccountId differs, but metaUserId is identical.
      const fb = await seedAccount(tx, {
        organizationId,
        profileId,
        platform: "facebook",
        platformAccountId: "page-1",
        metaUserId: "meta_user_1",
      });
      const ig = await seedAccount(tx, {
        organizationId,
        profileId,
        platform: "instagram",
        platformAccountId: "ig-scoped-1",
        metaUserId: "meta_user_1",
      });
      const th = await seedAccount(tx, {
        organizationId,
        profileId,
        platform: "threads",
        platformAccountId: "threads-1",
        metaUserId: "meta_user_1",
      });
      // A different Meta user — must survive.
      const other = await seedAccount(tx, {
        organizationId,
        profileId,
        platform: "facebook",
        platformAccountId: "page-2",
        metaUserId: "meta_user_2",
      });

      const res = await post(createApp({ db: tx }), "meta_user_1");
      expect(res.status).toBe(200);

      const repo = new DrizzlePlatformAccountsRepository(tx);
      expect(await repo.findById(fb.id)).toBeNull();
      expect(await repo.findById(ig.id)).toBeNull();
      expect(await repo.findById(th.id)).toBeNull();
      expect(await repo.findById(other.id)).not.toBeNull();
    });
  });

  it("deletes nothing when no stored metaUserId matches", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const { organizationId, profileId } = await seedOrgAndProfile(tx);
      const fb = await seedAccount(tx, {
        organizationId,
        profileId,
        platform: "facebook",
        platformAccountId: "page-1",
        metaUserId: "meta_user_1",
      });

      const res = await post(createApp({ db: tx }), "not_this_user");
      expect(res.status).toBe(200);

      const repo = new DrizzlePlatformAccountsRepository(tx);
      expect(await repo.findById(fb.id)).not.toBeNull();
    });
  });
});
