import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { LinkedInProvider } from "../src/platforms/linkedin/provider.js";
import {
  LinkedInClient,
  escapeLittleTextFormat,
} from "../src/platforms/linkedin/client.js";

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

const AUTHORIZE_URL = "https://test.example/linkedin/authorize";
const TOKEN_URL = "https://test.example/linkedin/token";
const API_BASE = "https://test.example/linkedin/api";

describe("LinkedInProvider", () => {
  it("describeConnect returns an oauth descriptor with narrow-by-default scopes", () => {
    const p = new LinkedInProvider({
      clientId: "client_xyz",
      clientSecret: "secret_xyz",
      authorizeUrl: AUTHORIZE_URL,
    });
    const descriptor = p.describeConnect({
      organizationId: "org_1",
      baseUrl: "https://api.letmepost.dev",
    });
    expect(descriptor.kind).toBe("oauth");
    if (descriptor.kind !== "oauth") throw new Error("expected oauth");

    expect(descriptor.codeVerifier).toBeUndefined();
    expect(descriptor.redirectUri).toBe(
      "https://api.letmepost.dev/v1/accounts/oauth/linkedin/callback",
    );
    const url = new URL(descriptor.authorizationUrl);
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe("client_xyz");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("w_member_social openid profile");
    expect(descriptor.scopes).not.toContain("w_organization_social");
  });

  it("completeConnect exchanges code, fetches userinfo, persists urn:li:person", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("code-abc");
        return HttpResponse.json({
          access_token: "li-access",
          refresh_token: "li-refresh",
          expires_in: 5_184_000, // 60 days
          refresh_token_expires_in: 31_536_000, // 1 year
          scope: "w_member_social openid profile",
        });
      }),
      http.get(`${API_BASE}/v2/userinfo`, () =>
        HttpResponse.json({
          sub: "ABCDEF123",
          name: "Alice Anderson",
          given_name: "Alice",
          family_name: "Anderson",
          email: "alice@example.com",
          picture: "https://media.licdn.com/img.jpg",
        }),
      ),
    );
    const p = new LinkedInProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    const account = await p.completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      {
        code: "code-abc",
        state: "s",
        redirectUri:
          "https://api.letmepost.dev/v1/accounts/oauth/linkedin/callback",
      },
    );
    expect(account.token).toBe("li-access");
    expect(account.platformAccountId).toBe("ABCDEF123");
    expect(account.displayName).toBe("Alice Anderson");
    expect(account.tokenMetadata).toMatchObject({
      refreshToken: "li-refresh",
      authorUrn: "urn:li:person:ABCDEF123",
      grantedScopes: ["w_member_social", "openid", "profile"],
    });
    expect(account.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it("completeConnect surfaces token-exchange failure as platform_auth_failed", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { error: "invalid_request", error_description: "bad code" },
          { status: 400 },
        ),
      ),
    );
    const p = new LinkedInProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
      apiBase: API_BASE,
    });
    await expect(
      p.completeConnect(
        { organizationId: "o", baseUrl: "https://x.example" },
        { code: "bad", state: "s", redirectUri: "https://x.example/cb" },
      ),
    ).rejects.toMatchObject({
      code: "platform_auth_failed",
      platform: "linkedin",
    });
  });

  it("completeConnect rejects payloads missing required fields", async () => {
    const p = new LinkedInProvider({ tokenUrl: TOKEN_URL, apiBase: API_BASE });
    await expect(
      p.completeConnect(
        { organizationId: "o", baseUrl: "https://x.example" },
        { code: "", state: "s", redirectUri: "https://x.example/cb" },
      ),
    ).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("refreshToken rotates access + refresh, carries authorUrn forward", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("stored-refresh");
        return HttpResponse.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 5_184_000,
          scope: "w_member_social openid profile",
        });
      }),
    );
    const p = new LinkedInProvider({
      clientId: "cid",
      clientSecret: "cs",
      tokenUrl: TOKEN_URL,
    });
    const result = await p.refreshToken({
      token: "old",
      tokenMetadata: {
        refreshToken: "stored-refresh",
        authorUrn: "urn:li:person:CARRIED",
        displayName: "Alice Anderson",
      },
    });
    expect(result.token).toBe("rotated-access");
    expect(result.tokenMetadata).toMatchObject({
      refreshToken: "rotated-refresh",
      authorUrn: "urn:li:person:CARRIED",
      displayName: "Alice Anderson",
    });
  });

  it("refreshToken throws platform_auth_failed when no refresh token is stored", async () => {
    const p = new LinkedInProvider({ tokenUrl: TOKEN_URL });
    await expect(
      p.refreshToken({ token: "x", tokenMetadata: null }),
    ).rejects.toMatchObject({
      code: "platform_auth_failed",
      platform: "linkedin",
    });
  });
});

describe("LinkedInClient createPost — Little Text Format escaping", () => {
  const client = new LinkedInClient("li-access", API_BASE, "202605");

  async function captureCommentary(text: string): Promise<string> {
    let captured: string | undefined;
    server.use(
      http.post(`${API_BASE}/rest/posts`, async ({ request }) => {
        const body = (await request.json()) as { commentary?: string };
        captured = body.commentary;
        return new HttpResponse(null, {
          status: 201,
          headers: { "x-restli-id": "urn:li:share:1" },
        });
      }),
    );
    await client.createPost({ authorUrn: "urn:li:person:X", text });
    if (captured === undefined) throw new Error("commentary not captured");
    return captured;
  }

  it("backslash-escapes LTF reserved characters in commentary", async () => {
    const commentary = await captureCommentary(
      "Check (this) [out] @ 50% off — a_b*c",
    );
    // Every reserved char present gets a leading backslash; non-reserved chars
    // (space, digits, %, em-dash, letters) are untouched.
    expect(commentary).toBe(
      "Check \\(this\\) \\[out\\] \\@ 50% off — a\\_b\\*c",
    );
  });

  it("escapes the full canonical reserved set once each", async () => {
    const commentary = await captureCommentary("\\|{}@[]()<>#*_~");
    expect(commentary).toBe(
      "\\\\\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\*\\_\\~",
    );
  });

  it("leaves plain text unchanged", async () => {
    const commentary = await captureCommentary(
      "Hello world 123 — no reserved chars here.",
    );
    expect(commentary).toBe("Hello world 123 — no reserved chars here.");
  });

  it("escapes a literal backslash exactly once (no double-escaping)", () => {
    expect(escapeLittleTextFormat("a\\b")).toBe("a\\\\b");
  });
});
