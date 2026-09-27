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

async function getRoot(url = "/", headers?: Record<string, string>) {
  const res = await createApp().request(url, headers ? { headers } : undefined);
  return { res, body: (await res.json()) as RootIndex };
}

/** Run `fn` with env vars set to the given values, restoring them afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const previous = new Map(
    Object.keys(vars).map((k) => [k, process.env[k]] as const),
  );
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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

  it("prefers the configured public origin", async () => {
    await withEnv({ BETTER_AUTH_URL: "https://api.letmepost.dev" }, async () => {
      const { body } = await getRoot("http://internal:3000/");

      expect(body.endpoints.posts).toBe("https://api.letmepost.dev/v1/posts");
      expect(body.authentication.oauth.discovery).toBe(
        "https://api.letmepost.dev/.well-known/oauth-protected-resource/mcp",
      );
    });
  });

  // Regression guard: TLS terminates at the Railway proxy, so c.req.url is
  // plain http:// with the internal host. The first deploy of this route
  // advertised "http://api.letmepost.dev/v1/posts" on an HTTPS-only API
  // because the tests set the scheme directly and never simulated a proxy.
  it("advertises https from the forwarded pair when no origin is configured", async () => {
    await withEnv({ BETTER_AUTH_URL: undefined }, async () => {
      const { body } = await getRoot("http://internal:3000/", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.letmepost.dev",
      });

      expect(body.endpoints.posts).toBe("https://api.letmepost.dev/v1/posts");
      expect(body.endpoints.health).toBe("https://api.letmepost.dev/health");
      expect(JSON.stringify(body.endpoints)).not.toContain("http://");
    });
  });

  it("takes the first hop when the proxy chain has several", async () => {
    await withEnv({ BETTER_AUTH_URL: undefined }, async () => {
      const { body } = await getRoot("http://internal:3000/", {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "api.letmepost.dev, internal:3000",
      });

      expect(body.endpoints.posts).toBe("https://api.letmepost.dev/v1/posts");
    });
  });

  // A forwarded proto with no forwarded host would otherwise pair https with
  // the internal request host and publish "https://internal:3000/v1/posts".
  it("ignores a forwarded proto that arrives without a host", async () => {
    await withEnv({ BETTER_AUTH_URL: undefined }, async () => {
      const { body } = await getRoot("http://internal:3000/", {
        "x-forwarded-proto": "https",
      });

      expect(body.endpoints.posts).toBe("http://internal:3000/v1/posts");
      expect(JSON.stringify(body.endpoints)).not.toContain("https://internal");
    });
  });

  it("ignores malformed forwarded values rather than emitting broken links", async () => {
    await withEnv({ BETTER_AUTH_URL: undefined }, async () => {
      for (const headers of [
        { "x-forwarded-proto": "ht tps", "x-forwarded-host": "api.letmepost.dev" },
        { "x-forwarded-proto": "javascript", "x-forwarded-host": "api.letmepost.dev" },
        { "x-forwarded-proto": "https", "x-forwarded-host": "evil.com/path" },
        { "x-forwarded-proto": "https", "x-forwarded-host": "has space" },
      ]) {
        const { body } = await getRoot("http://internal:3000/", headers);
        expect(body.endpoints.posts).toBe("http://internal:3000/v1/posts");
      }
    });
  });

  it("falls back to the request origin in local dev", async () => {
    await withEnv({ BETTER_AUTH_URL: undefined }, async () => {
      const { body } = await getRoot("http://localhost:3000/");

      expect(body.endpoints.posts).toBe("http://localhost:3000/v1/posts");
      expect(body.endpoints.health).toBe("http://localhost:3000/health");
    });
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
