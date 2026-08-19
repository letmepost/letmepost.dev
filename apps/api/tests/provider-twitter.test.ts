import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { TwitterProvider } from "../src/platforms/twitter/provider.js";

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

const AUTHORIZE_URL = "https://test.example/twitter/authorize";
const TOKEN_URL = "https://test.example/twitter/token";
const API_BASE = "https://test.example/twitter/api";

/** Mock `GET /2/users/me`, returning the given Twitter user id + username. */
function usersMeHandler(user: { id: string; username?: string }) {
  return http.get(`${API_BASE}/users/me`, ({ request }) => {
    expect(request.headers.get("authorization")).toMatch(/^Bearer /);
    return HttpResponse.json({ data: user });
  });
}

describe("TwitterProvider", () => {
  it("describeConnect includes a PKCE codeVerifier + S256 challenge and narrow scopes", () => {
    const p = new TwitterProvider({
      clientId: "client_x",
      clientSecret: "secret_x",
      authorizeUrl: AUTHORIZE_URL,
    });
    const descriptor = p.describeConnect({
      organizationId: "org_1",
      baseUrl: "https://api.letmepost.dev",
    });
    expect(descriptor.kind).toBe("oauth");
    if (descriptor.kind !== "oauth") throw new Error("expected oauth");

    expect(descriptor.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(descriptor.codeVerifier!.length).toBeGreaterThanOrEqual(43);
    expect(descriptor.redirectUri).toBe(
      "https://api.letmepost.dev/v1/accounts/oauth/twitter/callback",
    );
    const url = new URL(descriptor.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("scope")).toBe(
      // media.write is opt-in via TWITTER_MEDIA_SCOPE; an X app that cannot
      // grant it fails the whole authorize call with access_denied.
      "tweet.write tweet.read users.read offline.access",
    );
  });

  it("completeConnect exchanges code + codeVerifier for tokens and packs grantedScopes", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("auth-code");
        expect(form.get("code_verifier")).toBe("verifier-xyz");
        return HttpResponse.json({
          access_token: "tw-access",
          refresh_token: "tw-refresh",
          token_type: "bearer",
          expires_in: 7200,
          scope: "tweet.write tweet.read users.read offline.access",
        });
      }),
      usersMeHandler({ id: "44196397", username: "elonmusk" }),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const account = await p.completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      {
        code: "auth-code",
        state: "s",
        redirectUri: "https://api.letmepost.dev/v1/accounts/oauth/twitter/callback",
        codeVerifier: "verifier-xyz",
      },
    );
    expect(account.token).toBe("tw-access");
    expect(account.tokenMetadata).toMatchObject({ refreshToken: "tw-refresh" });
    expect(account.tokenExpiresAt).toBeInstanceOf(Date);
    expect(account.platformAccountId).toBe("44196397");
    expect(account.displayName).toBe("elonmusk");
  });

  it("completeConnect pins platformAccountId to the real Twitter user id from GET /2/users/me", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "tw-access",
          refresh_token: "tw-refresh",
          token_type: "bearer",
          expires_in: 7200,
          scope: "tweet.write tweet.read users.read offline.access",
        }),
      ),
      usersMeHandler({ id: "1234567890", username: "jack" }),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const account = await p.completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      {
        code: "auth-code",
        state: "s",
        redirectUri: "https://api.letmepost.dev/v1/accounts/oauth/twitter/callback",
        codeVerifier: "verifier-xyz",
      },
    );
    expect(account.platformAccountId).toBe("1234567890");
    expect(account.displayName).toBe("jack");
  });

  it("reconnecting the same Twitter user yields the SAME platformAccountId (upserts, no duplicate row)", async () => {
    // Two independent connects for the same upstream user — different codes and
    // rotated tokens, but /2/users/me resolves the same id both times. The id
    // must be stable so the (org, platform, platformAccountId) upsert hits the
    // existing row instead of minting a duplicate.
    const connect = async () => {
      server.use(
        http.post(TOKEN_URL, () =>
          HttpResponse.json({
            access_token: `tw-access-${Math.random()}`,
            refresh_token: `tw-refresh-${Math.random()}`,
            token_type: "bearer",
            expires_in: 7200,
            scope: "tweet.write tweet.read users.read offline.access",
          }),
        ),
        usersMeHandler({ id: "44196397", username: "elonmusk" }),
      );
      const p = new TwitterProvider({
        clientId: "cid",
        clientSecret: "cs",
        tokenUrl: TOKEN_URL,
        apiBase: API_BASE,
      });
      return p.completeConnect(
        { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
        {
          code: "auth-code",
          state: "s",
          redirectUri:
            "https://api.letmepost.dev/v1/accounts/oauth/twitter/callback",
          codeVerifier: "verifier-xyz",
        },
      );
    };

    const first = await connect();
    server.resetHandlers();
    const second = await connect();

    expect(first.platformAccountId).toBe("44196397");
    expect(second.platformAccountId).toBe(first.platformAccountId);
    // Sanity: tokens rotated, so this is a genuine second connect, not a cache hit.
    expect(second.token).not.toBe(first.token);
  });

  it("completeConnect throws platform_auth_failed when GET /2/users/me returns no user", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "tw-access",
          refresh_token: "tw-refresh",
          token_type: "bearer",
          expires_in: 7200,
          scope: "tweet.write tweet.read users.read offline.access",
        }),
      ),
      http.get(`${API_BASE}/users/me`, () =>
        HttpResponse.json({ title: "Unauthorized" }, { status: 401 }),
      ),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    await expect(
      p.completeConnect(
        { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
        {
          code: "auth-code",
          state: "s",
          redirectUri:
            "https://api.letmepost.dev/v1/accounts/oauth/twitter/callback",
          codeVerifier: "verifier-xyz",
        },
      ),
    ).rejects.toMatchObject({
      code: "platform_auth_failed",
      status: 401,
      platform: "twitter",
    });
  });

  it("completeConnect rejects payloads missing codeVerifier (PKCE required)", async () => {
    const p = new TwitterProvider({ tokenUrl: TOKEN_URL });
    await expect(
      p.completeConnect(
        { organizationId: "o", baseUrl: "https://x.example" },
        { code: "c", state: "s", redirectUri: "https://x.example/cb" },
      ),
    ).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("refreshToken rotates tokens using the stored refresh_token", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("stored-refresh");
        return HttpResponse.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "bearer",
          expires_in: 7200,
          scope: "tweet.write tweet.read users.read offline.access",
        });
      }),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    const result = await p.refreshToken({
      token: "old-access",
      tokenMetadata: { refreshToken: "stored-refresh" },
    });
    expect(result.token).toBe("rotated-access");
    expect(result.tokenMetadata).toMatchObject({ refreshToken: "rotated-refresh" });
  });

  it("refreshToken keeps the stored refresh token when X rotates only the access token", async () => {
    // X is not obliged to return a refresh_token on every refresh. Because
    // updateToken replaces tokenMetadata wholesale, dropping it here used to
    // wipe the stored one — the NEXT refresh then failed with "no refresh
    // token stored", revoked the account, and the user had to reconnect.
    server.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json({
          access_token: "rotated-access",
          token_type: "bearer",
          expires_in: 7200,
          scope: "tweet.write tweet.read users.read offline.access",
        }),
      ),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    const result = await p.refreshToken({
      token: "old-access",
      tokenMetadata: { refreshToken: "stored-refresh" },
    });
    expect(result.token).toBe("rotated-access");
    expect(result.tokenMetadata).toMatchObject({
      refreshToken: "stored-refresh",
    });
  });

  it("refreshToken carries the stored refresh token across a chain of non-rotating refreshes", async () => {
    server.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json({
          access_token: "rotated-access",
          token_type: "bearer",
          expires_in: 7200,
          scope: "tweet.write tweet.read users.read offline.access",
        }),
      ),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    let metadata: Record<string, unknown> | null = {
      refreshToken: "stored-refresh",
    };
    for (let i = 0; i < 3; i++) {
      const result = await p.refreshToken({ token: "old", tokenMetadata: metadata });
      metadata = result.tokenMetadata;
    }
    expect(metadata).toMatchObject({ refreshToken: "stored-refresh" });
  });

  it("refreshToken throws platform_auth_failed when no refresh token is present", async () => {
    const p = new TwitterProvider({ tokenUrl: TOKEN_URL });
    await expect(
      p.refreshToken({ token: "old", tokenMetadata: null }),
    ).rejects.toMatchObject({
      code: "platform_auth_failed",
      status: 401,
      platform: "twitter",
    });
  });

  it("refreshToken maps a transient 503 to retryable platform_unavailable (account NOT revoked)", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ error: "service_unavailable" }, { status: 503 }),
      ),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    await expect(
      p.refreshToken({
        token: "old-access",
        tokenMetadata: { refreshToken: "stored-refresh" },
      }),
    ).rejects.toMatchObject({
      code: "platform_unavailable",
      status: 503,
      platform: "twitter",
    });
  });

  it("refreshToken maps a transient 500 to retryable platform_unavailable", async () => {
    server.use(
      http.post(TOKEN_URL, () => new HttpResponse(null, { status: 500 })),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    await expect(
      p.refreshToken({
        token: "old-access",
        tokenMetadata: { refreshToken: "stored-refresh" },
      }),
    ).rejects.toMatchObject({
      code: "platform_unavailable",
      status: 503,
      platform: "twitter",
    });
  });

  it("refreshToken maps a 429 rate-limit to retryable platform_unavailable", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { title: "Too Many Requests" },
          { status: 429 },
        ),
      ),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    await expect(
      p.refreshToken({
        token: "old-access",
        tokenMetadata: { refreshToken: "stored-refresh" },
      }),
    ).rejects.toMatchObject({
      code: "platform_unavailable",
      status: 503,
      platform: "twitter",
    });
  });

  it("refreshToken maps a 400 invalid_grant to platform_auth_failed (genuine revocation)", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Value passed for the token was invalid.",
          },
          { status: 400 },
        ),
      ),
    );
    const p = new TwitterProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    await expect(
      p.refreshToken({
        token: "old-access",
        tokenMetadata: { refreshToken: "stored-refresh" },
      }),
    ).rejects.toMatchObject({
      code: "platform_auth_failed",
      status: 401,
      platform: "twitter",
    });
  });
});
