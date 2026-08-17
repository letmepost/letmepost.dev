import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { upstreamDetail } from "../src/platforms/_shared/errors.js";
import { TwitterClient } from "../src/platforms/twitter/client.js";

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

const API_BASE = "https://test.example/twitter/api";
const UPLOAD_BASE = "https://test.example/twitter/upload";

describe("upstreamDetail", () => {
  it("passes a parsed body through unchanged", () => {
    const body = { title: "Unauthorized", status: 401 };
    expect(upstreamDetail({ status: 401, body, raw: null })).toBe(body);
  });

  it("falls back to the raw text when the body didn't parse as JSON", () => {
    expect(upstreamDetail({ status: 502, body: undefined, raw: "<html>" })).toBe(
      "<html>",
    );
  });

  it("records the status when the platform answered with nothing at all", () => {
    // The case that made real rejections undiagnosable: no body, no raw, and
    // the status thrown away — leaving an error whose own remediation pointed
    // at a platformResponse that wasn't there.
    expect(upstreamDetail({ status: 403, body: undefined, raw: null })).toEqual({
      httpStatus: 403,
    });
  });
});

describe("TwitterClient error detail", () => {
  it("still says something when X rejects with an empty body", async () => {
    server.use(
      http.post(`${API_BASE}/tweets`, () => new HttpResponse(null, { status: 403 })),
    );
    const client = new TwitterClient("token", API_BASE, UPLOAD_BASE);

    await expect(client.createTweet({ text: "hello" })).rejects.toMatchObject({
      code: "platform_rejected",
      platform: "twitter",
      platformResponse: { httpStatus: 403 },
    });
  });

  it("keeps X's own error body when there is one", async () => {
    server.use(
      http.post(`${API_BASE}/tweets`, () =>
        HttpResponse.json(
          { title: "Unauthorized", detail: "Unauthorized", status: 401 },
          { status: 401 },
        ),
      ),
    );
    const client = new TwitterClient("token", API_BASE, UPLOAD_BASE);

    await expect(client.createTweet({ text: "hello" })).rejects.toMatchObject({
      code: "platform_auth_failed",
      platformResponse: { title: "Unauthorized", status: 401 },
    });
  });
});
