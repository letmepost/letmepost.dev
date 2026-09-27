import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";

type Endpoint = { url: string; auth: string };

type EndpointName =
  | "posts"
  | "media"
  | "webhookEndpoints"
  | "mcp"
  | "accounts"
  | "profiles"
  | "apiKeys"
  | "billing"
  | "health";

type RootIndex = {
  name: string;
  version: string;
  status: string;
  documentation: Record<string, string>;
  endpoints: Record<EndpointName, Endpoint>;
  authentication: {
    api_key: Record<string, string>;
    session: Record<string, string>;
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
    expect(body.endpoints.posts.url).toMatch(/\/v1\/posts$/);
    expect(body.endpoints.mcp.url).toMatch(/\/mcp$/);
  });

  // Regression guard: an earlier draft advertised a single Bearer scheme for
  // every endpoint, which would send callers to /v1/api-keys into a 401.
  it("labels session-only endpoints so callers don't send an API key", async () => {
    const { body } = await getRoot();

    expect(body.endpoints.accounts.auth).toBe("session");
    expect(body.endpoints.profiles.auth).toBe("session");
    expect(body.endpoints.apiKeys.auth).toBe("session");
    expect(body.endpoints.billing.auth).toBe("session");

    expect(body.endpoints.posts.auth).toBe("api_key_or_session");
    expect(body.endpoints.media.auth).toBe("api_key_or_session");
    expect(body.endpoints.webhookEndpoints.auth).toBe("api_key_or_session");
    expect(body.endpoints.mcp.auth).toBe("api_key");
    expect(body.endpoints.health.auth).toBe("none");
  });

  it("every endpoint declares a recognised auth mode", async () => {
    const { body } = await getRoot();
    const allowed = ["api_key", "session", "api_key_or_session", "none"];

    for (const [name, entry] of Object.entries(body.endpoints)) {
      expect(allowed, `${name} has an unrecognised auth mode`).toContain(
        entry.auth,
      );
      expect(entry.url, `${name} is missing a url`).toMatch(/^https?:\/\//);
    }
  });

  it("derives self-referencing links from the request origin", async () => {
    const { body } = await getRoot("http://localhost:3000/");

    expect(body.endpoints.posts.url).toBe("http://localhost:3000/v1/posts");
    expect(body.endpoints.health.url).toBe("http://localhost:3000/health");
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
