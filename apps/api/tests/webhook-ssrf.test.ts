import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { WebhookEvent } from "@letmepost/schemas";
import { deliverWebhook } from "../src/webhooks/deliver.js";

// `onUnhandledRequest: "error"` means any *real* outbound fetch to a host we
// haven't mocked fails the test loudly. Combined with an injected fetch spy on
// the blocked cases, this proves the SSRF guard short-circuits before the
// network is ever touched. Literal private IPs resolve to themselves, so the
// DNS lookup inside the guard is hermetic (no real query leaves the box).
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const event: WebhookEvent = {
  id: "evt_ssrf",
  type: "post.published",
  createdAt: "2026-07-05T00:00:00.000Z",
  organizationId: "org_1",
  data: { postId: "post_1" },
};

const signingSecret = "whsec_test";

describe("deliverWebhook — SSRF guard", () => {
  it.each([
    ["private RFC1918", "http://10.0.0.1/hook"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1/hook"],
  ])(
    "blocks a %s target (%s) without performing the outbound fetch",
    async (_label, url) => {
      let fetchCalls = 0;
      const spyFetch: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response("should never reach the target", { status: 200 });
      };

      const result = await deliverWebhook(
        { id: "whe_test", url, signingSecret },
        event,
        { fetch: spyFetch },
      );

      expect(fetchCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
      expect(result.errorName).toBe("SsrfBlockedError");
      expect(result.nonRetryable).toBeUndefined();
    },
  );

  it("blocks a non-http(s) scheme without performing the outbound fetch", async () => {
    let fetchCalls = 0;
    const spyFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response("nope", { status: 200 });
    };

    const result = await deliverWebhook(
      { id: "whe_test", url: "file:///etc/passwd", signingSecret },
      event,
      { fetch: spyFetch },
    );

    expect(fetchCalls).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.errorName).toBe("UnsupportedProtocolError");
  });

  it("still delivers to a normal public URL and reports the 2xx", async () => {
    const url = "https://consumer.example/webhook";
    server.use(http.post(url, () => HttpResponse.text("ok", { status: 200 })));

    const result = await deliverWebhook(
      { id: "whe_test", url, signingSecret },
      event,
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.responseBody).toBe("ok");
  });

  it("does not follow redirects (passes redirect:'manual'; 3xx is a failed delivery)", async () => {
    let seenRedirect: string | undefined;
    const spyFetch: typeof fetch = async (_input, init) => {
      seenRedirect = init?.redirect;
      // A public URL that 302s toward internal space. With redirect:"manual"
      // the client returns this 3xx rather than chasing the Location header.
      return new Response("", {
        status: 302,
        headers: { location: "http://169.254.169.254/" },
      });
    };

    const result = await deliverWebhook(
      { id: "whe_test", url: "https://consumer.example/webhook", signingSecret },
      event,
      { fetch: spyFetch },
    );

    expect(seenRedirect).toBe("manual");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(302);
  });
});
