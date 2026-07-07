import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { PinterestProvider } from "../src/platforms/pinterest/provider.js";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const AUTHORIZE_URL = "https://test.example/pinterest/authorize";
const TOKEN_URL = "https://test.example/pinterest/token";
const API_BASE = "https://test.example/pinterest/v5";

function userAccountHandler() {
  return http.get(`${API_BASE}/user_account`, () =>
    HttpResponse.json({
      id: "pinterest-user-987",
      username: "alice",
      account_type: "BUSINESS",
    }),
  );
}

function boardsHandler(items: { id: string; name: string }[]) {
  return http.get(`${API_BASE}/boards`, () =>
    HttpResponse.json({ items }),
  );
}

function tokenExchangeHandler() {
  return http.post(TOKEN_URL, async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-xyz");
    return HttpResponse.json({
      access_token: "access-token-abc",
      refresh_token: "refresh-token-def",
      token_type: "Bearer",
      expires_in: 2_592_000,
      refresh_token_expires_in: 5_184_000,
      scope: "boards:read boards:write pins:read pins:write user_accounts:read",
    });
  });
}

describe("PinterestProvider", () => {
  it("describeConnect returns an oauth descriptor with narrow-by-default scopes and a computed redirectUri", () => {
    const p = new PinterestProvider({
      clientId: "client_abc",
      clientSecret: "secret_def",
      authorizeUrl: AUTHORIZE_URL,
    });
    const descriptor = p.describeConnect({
      organizationId: "org_1",
      baseUrl: "https://api.letmepost.dev",
    });
    expect(descriptor.kind).toBe("oauth");
    if (descriptor.kind !== "oauth") throw new Error("expected oauth");

    const url = new URL(descriptor.authorizationUrl);
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe("client_abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe(descriptor.state);
    expect(url.searchParams.get("scope")).toBe(
      "boards:read,boards:write,pins:read,pins:write,user_accounts:read",
    );
    expect(descriptor.redirectUri).toBe(
      "https://api.letmepost.dev/v1/accounts/oauth/pinterest/callback",
    );
    expect(descriptor.codeVerifier).toBeUndefined();
  });

  it("completeConnect uses the real Pinterest user id + seeds defaultBoardId from /v5/boards", async () => {
    server.use(
      tokenExchangeHandler(),
      userAccountHandler(),
      boardsHandler([
        { id: "board-first", name: "Pins to share" },
        { id: "board-second", name: "Inspo" },
      ]),
    );
    const p = new PinterestProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const account = await p.completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      {
        code: "auth-code-xyz",
        state: "s",
        redirectUri:
          "https://api.letmepost.dev/v1/accounts/oauth/pinterest/callback",
      },
    );
    expect(account.token).toBe("access-token-abc");
    expect(account.platformAccountId).toBe("pinterest-user-987");
    expect(account.displayName).toBe("alice");
    expect(account.tokenMetadata).toMatchObject({
      refreshToken: "refresh-token-def",
      grantedScopes: [
        "boards:read",
        "boards:write",
        "pins:read",
        "pins:write",
        "user_accounts:read",
      ],
      defaultBoardId: "board-first",
      defaultBoardName: "Pins to share",
    });
    expect(account.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it("completeConnect succeeds without a defaultBoardId when the user has no boards yet", async () => {
    server.use(
      tokenExchangeHandler(),
      userAccountHandler(),
      boardsHandler([]),
    );
    const p = new PinterestProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const account = await p.completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      {
        code: "auth-code-xyz",
        state: "s",
        redirectUri:
          "https://api.letmepost.dev/v1/accounts/oauth/pinterest/callback",
      },
    );
    expect(account.platformAccountId).toBe("pinterest-user-987");
    expect(
      (account.tokenMetadata as Record<string, unknown> | null)?.defaultBoardId,
    ).toBeUndefined();
  });

  it("completeConnect surfaces zod validation errors as validation_failed", async () => {
    const p = new PinterestProvider({ tokenUrl: TOKEN_URL, apiBase: API_BASE });
    await expect(
      p.completeConnect(
        { organizationId: "o", baseUrl: "https://x.example" },
        { code: "", state: "s", redirectUri: "https://x.example/cb" },
      ),
    ).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("refreshToken rotates the access token using the stored refresh token", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("stored-refresh");
        return HttpResponse.json({
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 2_592_000,
          scope: "boards:read boards:write pins:read pins:write user_accounts:read",
        });
      }),
    );
    const p = new PinterestProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    const result = await p.refreshToken({
      token: "old-access",
      tokenMetadata: { refreshToken: "stored-refresh" },
    });
    expect(result.token).toBe("new-access");
    expect(result.tokenMetadata).toMatchObject({ refreshToken: "rotated-refresh" });
    expect(result.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it("refreshToken preserves the persisted default board and updates access token + expiry", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 2_592_000,
          scope: "boards:read boards:write pins:read pins:write user_accounts:read",
        }),
      ),
    );
    const p = new PinterestProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    const before = Date.now();
    const result = await p.refreshToken({
      token: "old-access",
      tokenMetadata: {
        refreshToken: "stored-refresh",
        defaultBoardId: "board-first",
        defaultBoardName: "Pins to share",
      },
    });
    expect(result.token).toBe("new-access");
    expect(result.tokenMetadata).toMatchObject({
      refreshToken: "rotated-refresh",
      defaultBoardId: "board-first",
      defaultBoardName: "Pins to share",
    });
    expect(result.tokenExpiresAt).toBeInstanceOf(Date);
    expect(result.tokenExpiresAt?.getTime()).toBeGreaterThan(before);
  });

  it("refreshToken retains the existing refresh token when Pinterest omits a new one", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 2_592_000,
          scope: "boards:read boards:write pins:read pins:write user_accounts:read",
        }),
      ),
    );
    const p = new PinterestProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    const result = await p.refreshToken({
      token: "old-access",
      tokenMetadata: {
        refreshToken: "stored-refresh",
        defaultBoardId: "board-first",
        defaultBoardName: "Pins to share",
      },
    });
    expect(result.token).toBe("new-access");
    expect(result.tokenMetadata).toMatchObject({
      refreshToken: "stored-refresh",
      defaultBoardId: "board-first",
      defaultBoardName: "Pins to share",
    });
  });

  it("refreshToken throws platform_auth_failed when no refresh token is present", async () => {
    const p = new PinterestProvider({ tokenUrl: TOKEN_URL });
    await expect(
      p.refreshToken({ token: "old", tokenMetadata: null }),
    ).rejects.toMatchObject({
      code: "platform_auth_failed",
      status: 401,
      platform: "pinterest",
    });
  });
});
