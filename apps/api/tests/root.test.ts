import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";

type RootIndex = {
  name: string;
  version: string;
  status: string;
  documentation: Record<string, string>;
  endpoints: Record<string, string>;
  authentication: Record<string, string>;
};

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
      "https://docs.letmepost.dev/api-reference/openapi.json",
    );
    expect(body.endpoints.posts).toMatch(/\/v1\/posts$/);
    expect(body.endpoints.mcp).toMatch(/\/mcp$/);
    expect(body.authentication.scheme).toBe("Bearer");
  });

  it("derives self-referencing links from the request origin", async () => {
    const { body } = await getRoot("http://localhost:3000/");

    expect(body.endpoints.posts).toBe("http://localhost:3000/v1/posts");
    expect(body.endpoints.health).toBe("http://localhost:3000/health");
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
