import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { ThreadsClient } from "../src/platforms/threads/client.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API_BASE = "https://test.example/threads";
const VERSION = "v1.0";
const PUBLISH_URL = `${API_BASE}/${VERSION}/me/threads_publish`;

function client() {
  return new ThreadsClient("tok", API_BASE, VERSION);
}

describe("ThreadsClient publish error mapping — transient reclassification", () => {
  it("maps HTTP 429 to platform_unavailable (retryable)", async () => {
    server.use(
      http.post(PUBLISH_URL, () =>
        HttpResponse.json(
          { error: { message: "rate limited" } },
          { status: 429 },
        ),
      ),
    );
    await expect(client().publishContainer("me", "cid")).rejects.toMatchObject({
      code: "platform_unavailable",
      status: 503,
    });
  });

  it("maps rate-limit code 4 to platform_unavailable", async () => {
    server.use(
      http.post(PUBLISH_URL, () =>
        HttpResponse.json({ error: { code: 4, message: "app limit" } }),
      ),
    );
    await expect(client().publishContainer("me", "cid")).rejects.toMatchObject({
      code: "platform_unavailable",
    });
  });

  it("maps 5xx responses to platform_unavailable", async () => {
    server.use(
      http.post(PUBLISH_URL, () =>
        HttpResponse.json(
          { error: { message: "server error" } },
          { status: 502 },
        ),
      ),
    );
    await expect(client().publishContainer("me", "cid")).rejects.toMatchObject({
      code: "platform_unavailable",
    });
  });

  it("maps transient code 1 (unknown error, please retry) to platform_unavailable", async () => {
    server.use(
      http.post(PUBLISH_URL, () =>
        HttpResponse.json({
          error: { code: 1, message: "unknown error, please retry" },
        }),
      ),
    );
    await expect(client().publishContainer("me", "cid")).rejects.toMatchObject({
      code: "platform_unavailable",
    });
  });
});

describe("ThreadsClient publish error mapping — permanent failures unchanged", () => {
  it("keeps invalid parameter (code 100) as platform_rejected", async () => {
    server.use(
      http.post(PUBLISH_URL, () =>
        HttpResponse.json(
          { error: { code: 100, message: "bad param" } },
          { status: 400 },
        ),
      ),
    );
    await expect(client().publishContainer("me", "cid")).rejects.toMatchObject({
      code: "platform_rejected",
    });
  });

  it("keeps invalid/expired token (code 190) as platform_auth_failed", async () => {
    server.use(
      http.post(PUBLISH_URL, () =>
        HttpResponse.json(
          { error: { code: 190, message: "expired" } },
          { status: 401 },
        ),
      ),
    );
    await expect(client().publishContainer("me", "cid")).rejects.toMatchObject({
      code: "platform_auth_failed",
    });
  });
});
