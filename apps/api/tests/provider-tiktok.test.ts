import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  classifyAuditState,
  TikTokProvider,
  type TikTokTokenMetadata,
} from "../src/platforms/tiktok/provider.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const AUTHORIZE_URL = "https://test.example/tiktok/authorize";
const TOKEN_URL = "https://test.example/tiktok/token";
const API_BASE = "https://test.example/tiktok-api";

function userInfoHandler(data: {
  open_id: string;
  union_id?: string;
  display_name?: string;
  username?: string;
}) {
  return http.get(`${API_BASE}/v2/user/info/`, () =>
    HttpResponse.json({
      data: { user: data },
      error: { code: "ok" },
    }),
  );
}

function creatorInfoHandler(privacyOptions: string[]) {
  return http.post(
    `${API_BASE}/v2/post/publish/creator_info/query/`,
    () =>
      HttpResponse.json({
        data: {
          privacy_level_options: privacyOptions,
          creator_username: "alice",
          max_video_post_duration_sec: 60,
        },
        error: { code: "ok" },
      }),
  );
}

function tokenExchangeHandler() {
  return http.post(TOKEN_URL, async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-xyz");
    expect(form.get("code_verifier")).toBeTruthy();
    return HttpResponse.json({
      access_token: "access-tok-1",
      refresh_token: "refresh-tok-1",
      token_type: "Bearer",
      expires_in: 86_400,
      refresh_expires_in: 365 * 24 * 60 * 60,
      scope: "user.info.basic,video.upload",
      open_id: "open-id-123",
    });
  });
}

describe("classifyAuditState", () => {
  it("classifies SELF_ONLY-only as audit", () => {
    expect(
      classifyAuditState({ privacy_level_options: ["SELF_ONLY"] }),
    ).toBe("audit");
  });
  it("classifies multi-option lists as production", () => {
    expect(
      classifyAuditState({
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      }),
    ).toBe("production");
  });
  it("classifies empty option lists as audit", () => {
    expect(classifyAuditState({ privacy_level_options: [] })).toBe("audit");
  });
});

describe("TikTokProvider", () => {
  it("describeConnect builds an oauth URL with PKCE + client_key", () => {
    const p = new TikTokProvider({
      clientKey: "key_abc",
      clientSecret: "sec_def",
      authorizeUrl: AUTHORIZE_URL,
    });
    const d = p.describeConnect({
      organizationId: "org_1",
      baseUrl: "https://api.letmepost.dev",
    });
    expect(d.kind).toBe("oauth");
    if (d.kind !== "oauth") throw new Error("expected oauth");
    const url = new URL(d.authorizationUrl);
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get("client_key")).toBe("key_abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe(
      "user.info.basic,video.upload",
    );
    expect(d.redirectUri).toBe(
      "https://api.letmepost.dev/v1/accounts/oauth/tiktok/callback",
    );
    expect(d.codeVerifier).toBeTruthy();
  });

  it("completeConnect pins open_id, snapshots creator_info, classifies audit", async () => {
    server.use(
      tokenExchangeHandler(),
      userInfoHandler({
        open_id: "open-id-123",
        display_name: "Alice",
        username: "alice",
      }),
      creatorInfoHandler(["SELF_ONLY"]),
    );
    const p = new TikTokProvider({
      clientKey: "k",
      clientSecret: "s",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const acc = await p.completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      {
        code: "auth-code-xyz",
        state: "s",
        redirectUri:
          "https://api.letmepost.dev/v1/accounts/oauth/tiktok/callback",
        codeVerifier: "pkce-verifier-xyz",
      },
    );
    expect(acc.platformAccountId).toBe("open-id-123");
    expect(acc.displayName).toBe("Alice");
    expect(acc.token).toBe("access-tok-1");
    const md = acc.tokenMetadata as TikTokTokenMetadata;
    expect(md.refreshToken).toBe("refresh-tok-1");
    expect(md.openId).toBe("open-id-123");
    expect(md.username).toBe("alice");
    expect(md.auditState).toBe("audit");
    expect(md.privacyLevelOptions).toEqual(["SELF_ONLY"]);
    expect(md.grantedScopes).toEqual(["user.info.basic", "video.upload"]);
    expect(acc.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it("completeConnect classifies production correctly when allowlist includes public", async () => {
    server.use(
      tokenExchangeHandler(),
      userInfoHandler({
        open_id: "open-id-prod",
        display_name: "Bob",
        username: "bob",
      }),
      creatorInfoHandler(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]),
    );
    const p = new TikTokProvider({
      clientKey: "k",
      clientSecret: "s",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const acc = await p.completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      {
        code: "auth-code-xyz",
        state: "s",
        redirectUri:
          "https://api.letmepost.dev/v1/accounts/oauth/tiktok/callback",
        codeVerifier: "pkce-verifier-xyz",
      },
    );
    const md = acc.tokenMetadata as TikTokTokenMetadata;
    expect(md.auditState).toBe("production");
    expect(md.privacyLevelOptions).toEqual([
      "PUBLIC_TO_EVERYONE",
      "SELF_ONLY",
    ]);
  });

  it("completeConnect falls back to audit when creator_info errors", async () => {
    server.use(
      tokenExchangeHandler(),
      userInfoHandler({
        open_id: "open-id-fallback",
        display_name: "Carol",
        username: "carol",
      }),
      http.post(
        `${API_BASE}/v2/post/publish/creator_info/query/`,
        () =>
          HttpResponse.json(
            { error: { code: "scope_not_authorized", message: "no scope" } },
            { status: 200 },
          ),
      ),
    );
    const p = new TikTokProvider({
      clientKey: "k",
      clientSecret: "s",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const acc = await p.completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      {
        code: "auth-code-xyz",
        state: "s",
        redirectUri:
          "https://api.letmepost.dev/v1/accounts/oauth/tiktok/callback",
        codeVerifier: "pkce-verifier-xyz",
      },
    );
    const md = acc.tokenMetadata as TikTokTokenMetadata;
    expect(md.auditState).toBe("audit");
  });

  it("refreshToken uses stored refresh token and carries cached openId", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("refresh-tok-1");
        return HttpResponse.json({
          access_token: "access-tok-2",
          refresh_token: "refresh-tok-2",
          token_type: "Bearer",
          expires_in: 86_400,
          refresh_expires_in: 365 * 24 * 60 * 60,
          scope: "user.info.basic,video.upload",
        });
      }),
      creatorInfoHandler(["SELF_ONLY"]),
    );
    const p = new TikTokProvider({
      clientKey: "k",
      clientSecret: "s",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const refreshed = await p.refreshToken({
      token: "old-token",
      tokenMetadata: {
        refreshToken: "refresh-tok-1",
        openId: "open-id-123",
        username: "alice",
      } as TikTokTokenMetadata,
    });
    expect(refreshed.token).toBe("access-tok-2");
    const md = refreshed.tokenMetadata as TikTokTokenMetadata;
    expect(md.openId).toBe("open-id-123");
    expect(md.username).toBe("alice");
    expect(md.refreshToken).toBe("refresh-tok-2");
  });

  it("refreshToken errors when no refresh token is stored", async () => {
    const p = new TikTokProvider({ clientKey: "k", clientSecret: "s" });
    await expect(
      p.refreshToken({ token: "t", tokenMetadata: {} }),
    ).rejects.toMatchObject({ code: "platform_auth_failed" });
  });
});
