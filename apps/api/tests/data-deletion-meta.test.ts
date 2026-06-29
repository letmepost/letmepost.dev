import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const SECRET = "fb_app_secret_test_for_callback";

function base64Url(buf: Buffer | string): string {
  return (typeof buf === "string" ? Buffer.from(buf, "utf8") : buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeSignedRequest(
  payload: Record<string, unknown>,
  secret = SECRET,
): string {
  const encodedPayload = base64Url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(encodedPayload).digest();
  return `${base64Url(sig)}.${encodedPayload}`;
}

describe("POST /data-deletion/meta", () => {
  let savedSecret: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.META_APP_SECRET;
    savedBaseUrl = process.env.PUBLIC_API_BASE_URL;
    process.env.META_APP_SECRET = SECRET;
    process.env.PUBLIC_API_BASE_URL = "https://api.letmepost.dev";
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = savedSecret;
    if (savedBaseUrl === undefined) delete process.env.PUBLIC_API_BASE_URL;
    else process.env.PUBLIC_API_BASE_URL = savedBaseUrl;
  });

  it("returns the Meta-required JSON shape on a valid signed_request", async () => {
    const app = createApp();
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "fb_user_42",
      issued_at: Math.floor(Date.now() / 1000),
    });
    const body = new URLSearchParams({ signed_request: sr });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      url: string;
      confirmation_code: string;
    };
    expect(json.url).toMatch(
      /^https:\/\/api\.letmepost\.dev\/data-deletion\/status\?code=lmp_/,
    );
    expect(json.confirmation_code).toMatch(/^lmp_/);
  });

  it("also accepts JSON bodies (test fixtures)", async () => {
    const app = createApp();
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "fb_user_42",
      issued_at: Math.floor(Date.now() / 1000),
    });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed_request: sr }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a stale signed_request (replay guard)", async () => {
    const app = createApp();
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "fb_user_42",
      issued_at: Math.floor(Date.now() / 1000) - 48 * 60 * 60,
    });
    const body = new URLSearchParams({ signed_request: sr });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "signed_request_invalid" });
  });

  it("rejects a signed_request with no issued_at (replay guard)", async () => {
    const app = createApp();
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "fb_user_42",
    });
    const body = new URLSearchParams({ signed_request: sr });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 if signed_request is missing", async () => {
    const app = createApp();
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "signed_request_missing" });
  });

  it("returns 400 if signed_request is signed with the wrong secret", async () => {
    const app = createApp();
    const sr = makeSignedRequest(
      { algorithm: "HMAC-SHA256", user_id: "fb_user_42" },
      "wrong_secret",
    );
    const body = new URLSearchParams({ signed_request: sr });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "signed_request_invalid" });
  });

  it("returns 503 when META_APP_SECRET is not configured", async () => {
    delete process.env.META_APP_SECRET;
    const app = createApp();
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "fb_user_42",
    });
    const body = new URLSearchParams({ signed_request: sr });
    const res = await app.request("/data-deletion/meta", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /data-deletion/status", () => {
  it("renders an HTML page with the confirmation code", async () => {
    const app = createApp();
    const res = await app.request("/data-deletion/status?code=lmp_abc123");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Data deletion request");
    expect(body).toContain("lmp_abc123");
  });

  it("html-escapes the code query param", async () => {
    const app = createApp();
    const res = await app.request(
      `/data-deletion/status?code=${encodeURIComponent("<script>alert(1)</script>")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});
