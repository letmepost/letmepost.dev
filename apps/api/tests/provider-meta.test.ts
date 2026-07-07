import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MetaProvider } from "../src/platforms/meta/provider.js";

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

const TOKEN_URL = "https://test.example/fb/oauth/access_token";
const GRAPH_BASE = "https://test.example/graph";
const VERSION = "v23.0";
const REDIRECT_URI =
  "https://api.letmepost.dev/v1/accounts/oauth/facebook/callback";

/** Short→long token swap both hit TOKEN_URL (GET); differ by grant_type. */
function tokenHandler() {
  return http.get(TOKEN_URL, ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("grant_type") === "fb_exchange_token") {
      return HttpResponse.json({
        access_token: "long-lived-user-token",
        token_type: "bearer",
        expires_in: 5_184_000,
      });
    }
    return HttpResponse.json({
      access_token: "short-lived-user-token",
      token_type: "bearer",
    });
  });
}

function meHandler(id: string, calls: { count: number }) {
  return http.get(`${GRAPH_BASE}/${VERSION}/me`, () => {
    calls.count += 1;
    return HttpResponse.json({ id, name: "Rose K" });
  });
}

function pagesHandler(pages: { id: string; name: string; tasks?: string[] }[]) {
  return http.get(`${GRAPH_BASE}/${VERSION}/me/accounts`, () =>
    HttpResponse.json({
      data: pages.map((p) => ({
        id: p.id,
        name: p.name,
        access_token: `page-token-${p.id}`,
        ...(p.tasks ? { tasks: p.tasks } : {}),
      })),
    }),
  );
}

function newProvider() {
  return new MetaProvider({
    clientId: "cid",
    clientSecret: "cs",
    tokenUrl: TOKEN_URL,
    graphBase: GRAPH_BASE,
    graphVersion: VERSION,
  });
}

describe("MetaProvider.completeConnect", () => {
  it("persists the connecting user's app-scoped id as tokenMetadata.metaUserId on every Page row", async () => {
    const calls = { count: 0 };
    server.use(
      tokenHandler(),
      meHandler("meta_user_99", calls),
      pagesHandler([
        { id: "page-1", name: "Page One", tasks: ["CREATE_CONTENT"] },
        { id: "page-2", name: "Page Two" },
      ]),
    );

    const records = await newProvider().completeConnect(
      { organizationId: "o", baseUrl: "https://api.letmepost.dev" },
      { code: "auth-code", state: "s", redirectUri: REDIRECT_URI },
    );

    // GET /me must actually be hit — that's where the app-scoped id comes from.
    expect(calls.count).toBe(1);
    expect(records).toHaveLength(2);

    const [first, second] = records;
    expect(first!.platform).toBe("facebook");
    // platformAccountId stays the Page id — NOT the app-scoped user id.
    expect(first!.platformAccountId).toBe("page-1");
    expect(first!.token).toBe("page-token-page-1");
    expect(first!.tokenMetadata).toMatchObject({
      kind: "page",
      metaUserId: "meta_user_99",
      pageTasks: ["CREATE_CONTENT"],
    });

    // Every Page row carries the same app-scoped id so the deletion/deauth
    // callbacks catch all of them for this user.
    expect(second!.platformAccountId).toBe("page-2");
    expect(second!.tokenMetadata).toMatchObject({
      kind: "page",
      metaUserId: "meta_user_99",
    });
  });
});
