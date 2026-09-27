import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";

type RootIndex = {
  name: string;
  version: string;
  status: string;
  documentation: Record<string, string | undefined>;
  endpoints: Record<string, string | undefined>;
  authentication: {
    apiKey: { scheme: string; header: string; mint: string };
    session: { description: string; dashboard: string };
    oauth: { description: string; discovery: string };
    docs: string;
  };
};

/** Mirrors the route's own default so the suite passes with or without the override set. */
const docsBase = () =>
  process.env.DOCS_BASE_URL ?? "https://docs.letmepost.dev";

async function getRoot(url = "/") {
  const res = await createApp().request(url);
  return { res, body: (await res.json()) as RootIndex };
}

describe("GET /", () => {
  it("serves a service index instead of a 404", async () => {
    const { res, body } = await getRoot();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.name).toBe("letmepost.dev");
    expect(body.version).toBe("v1");
    expect(body.status).toBe("ok");
  });

  it("points at the docs and the main endpoints", async () => {
    const { body } = await getRoot();

    expect(body.documentation.openapi).toBe(
      `${docsBase()}/api-reference/openapi.json`,
    );
    expect(body.endpoints.posts).toMatch(/\/v1\/posts$/);
    expect(body.endpoints.mcp).toMatch(/\/mcp$/);
  });

  it("lists every public surface", async () => {
    const { body } = await getRoot();

    for (const name of [
      "posts",
      "media",
      "accounts",
      "profiles",
      "webhookEndpoints",
      "apiKeys",
      "billing",
      "mcp",
      "health",
    ]) {
      expect(body.endpoints[name], `${name} is missing`).toMatch(
        /^https?:\/\//,
      );
    }
  });

  // Regression guard: earlier drafts claimed a per-path auth mode here and got
  // it wrong twice — auth varies by operation (GET /v1/accounts takes a Bearer
  // key, DELETE /v1/accounts/:id does not). The index must name all three
  // schemes and defer to the prose docs rather than restate the matrix.
  it("names every auth scheme and defers detail to the prose docs", async () => {
    const { body } = await getRoot();

    expect(body.authentication.apiKey.scheme).toBe("Bearer");
    expect(body.authentication.session.dashboard).toContain("dashboard");
    expect(body.authentication.docs).toBe(`${docsBase()}/authentication`);
  });

  // The OpenAPI spec models only the Bearer scheme and marks session-only
  // operations `security: []`, which reads as "public". The index must not
  // send callers there for the auth answer.
  it("does not name the OpenAPI spec as the authentication authority", async () => {
    const { body } = await getRoot();

    expect(JSON.stringify(body.authentication)).not.toContain("openapi.json");
  });

  it("does not restate a per-path auth mode that would drift from the spec", async () => {
    const { body } = await getRoot();

    for (const value of Object.values(body.endpoints)) {
      expect(typeof value).toBe("string");
    }
  });

  it("derives self-referencing links from the request origin", async () => {
    const { body } = await getRoot("http://localhost:3000/");

    expect(body.endpoints.posts).toBe("http://localhost:3000/v1/posts");
    expect(body.endpoints.health).toBe("http://localhost:3000/health");
    expect(body.authentication.oauth.discovery).toBe(
      "http://localhost:3000/.well-known/oauth-protected-resource/mcp",
    );
  });

  // Regression guard: TLS terminates at the Railway proxy, so c.req.url is
  // plain http:// with the internal host. The first deploy of this route
  // advertised "http://api.letmepost.dev/v1/posts" on an HTTPS-only API
  // because the tests set the scheme directly and never simulated a proxy.
  it("advertises https when the proxy forwards it", async () => {
    const res = await createApp().request("http://internal:3000/", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.letmepost.dev",
      },
    });
    const body = (await res.json()) as RootIndex;

    expect(body.endpoints.posts).toBe("https://api.letmepost.dev/v1/posts");
    expect(body.endpoints.health).toBe("https://api.letmepost.dev/health");
    expect(body.authentication.oauth.discovery).toBe(
      "https://api.letmepost.dev/.well-known/oauth-protected-resource/mcp",
    );
    expect(JSON.stringify(body.endpoints)).not.toContain("http://");
  });

  it("takes the first hop when the proxy chain has several", async () => {
    const res = await createApp().request("http://internal:3000/", {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "api.letmepost.dev, internal:3000",
      },
    });
    const body = (await res.json()) as RootIndex;

    expect(body.endpoints.posts).toBe("https://api.letmepost.dev/v1/posts");
  });

  it("honours DOCS_BASE_URL so staging describes itself", async () => {
    const previous = process.env.DOCS_BASE_URL;
    process.env.DOCS_BASE_URL = "https://docs-staging.letmepost.dev";
    try {
      const { body } = await getRoot();
      expect(body.documentation.docs).toBe("https://docs-staging.letmepost.dev");
      expect(body.documentation.quickstart).toBe(
        "https://docs-staging.letmepost.dev/quickstart",
      );
    } finally {
      if (previous === undefined) delete process.env.DOCS_BASE_URL;
      else process.env.DOCS_BASE_URL = previous;
    }
  });

  it("does not shadow the routes mounted below it", async () => {
    const res = await createApp().request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
