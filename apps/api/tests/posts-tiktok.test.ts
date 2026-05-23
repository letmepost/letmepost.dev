import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  pollTikTokPublishStatus,
  tiktokPublisher,
} from "../src/platforms/tiktok/publisher.js";
import { LetmepostError } from "../src/errors.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API_BASE = "https://test.example/tiktok-api";
const UPLOAD_URL = "https://test.example/tiktok-upload";

function initInboxHandler() {
  return http.post(
    `${API_BASE}/v2/post/publish/inbox/video/init/`,
    async ({ request }) => {
      const body = (await request.json()) as {
        source_info?: { source?: string };
      };
      expect(body.source_info?.source).toBe("FILE_UPLOAD");
      return HttpResponse.json({
        data: {
          publish_id: "pub-id-abc",
          upload_url: UPLOAD_URL,
        },
        error: { code: "ok" },
      });
    },
  );
}

function uploadPutHandler() {
  return http.put(UPLOAD_URL, () =>
    new HttpResponse(null, { status: 201 }),
  );
}

function videoUrlHandler() {
  return http.get(
    "https://example.com/clip.mp4",
    () =>
      new HttpResponse(new Uint8Array(1024 * 4), {
        headers: { "Content-Type": "video/mp4" },
      }),
  );
}

describe("tiktokPublisher.publish", () => {
  it("inits upload, PUTs bytes, returns publish_id stamped on cid with audit warning", async () => {
    server.use(initInboxHandler(), uploadPutHandler(), videoUrlHandler());
    const result = await tiktokPublisher.publish(
      {
        accessToken: "token-1",
        apiBase: API_BASE,
        auditState: "audit",
        privacyLevelOptions: ["SELF_ONLY"],
      },
      {
        text: "Hello TikTok",
        privacy: "public_to_everyone",
        media: [{ kind: "video", url: "https://example.com/clip.mp4" }],
      },
    );
    expect(result.id).toBe("pub-id-abc");
    expect(result.cid).toBe("pub-id-abc");
    expect(result.status).toBe("publishing");
    expect(result.platform).toBe("tiktok");
    const warningCodes = (result.warnings ?? []).map((w) => w.code);
    expect(warningCodes).toContain("tiktok.audit.self_only");
  });

  it("rejects via auth failure on 401 from init", async () => {
    server.use(
      videoUrlHandler(),
      http.post(
        `${API_BASE}/v2/post/publish/inbox/video/init/`,
        () =>
          HttpResponse.json(
            { error: { code: "access_token_invalid", message: "bad token" } },
            { status: 401 },
          ),
      ),
    );
    await expect(
      tiktokPublisher.publish(
        {
          accessToken: "bad",
          apiBase: API_BASE,
          auditState: "audit",
          privacyLevelOptions: ["SELF_ONLY"],
        },
        {
          text: "Hello",
          media: [{ kind: "video", url: "https://example.com/clip.mp4" }],
        },
      ),
    ).rejects.toMatchObject({ code: "platform_auth_failed" });
  });

  it("rejects an upload chunk failure", async () => {
    server.use(
      initInboxHandler(),
      videoUrlHandler(),
      http.put(
        UPLOAD_URL,
        () => new HttpResponse("forbidden", { status: 403 }),
      ),
    );
    await expect(
      tiktokPublisher.publish(
        {
          accessToken: "tok",
          apiBase: API_BASE,
          auditState: "audit",
          privacyLevelOptions: ["SELF_ONLY"],
        },
        {
          text: "Hello",
          media: [{ kind: "video", url: "https://example.com/clip.mp4" }],
        },
      ),
    ).rejects.toMatchObject({
      code: "platform_rejected",
    });
  });

  it("preflight rejects multi-media payload before any network call", async () => {
    let called = false;
    server.use(
      http.post(
        `${API_BASE}/v2/post/publish/inbox/video/init/`,
        () => {
          called = true;
          return HttpResponse.json({
            data: { publish_id: "x", upload_url: UPLOAD_URL },
          });
        },
      ),
    );
    await expect(
      tiktokPublisher.publish(
        {
          accessToken: "tok",
          apiBase: API_BASE,
          auditState: "audit",
          privacyLevelOptions: ["SELF_ONLY"],
        },
        {
          text: "x",
          media: [
            { kind: "video", url: "https://example.com/a.mp4" },
            { kind: "video", url: "https://example.com/b.mp4" },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(LetmepostError);
    expect(called).toBe(false);
  });
});

describe("pollTikTokPublishStatus", () => {
  it("maps PUBLISH_COMPLETE → terminal published with public url", async () => {
    server.use(
      http.post(
        `${API_BASE}/v2/post/publish/status/fetch/`,
        () =>
          HttpResponse.json({
            data: {
              status: "PUBLISH_COMPLETE",
              publicaly_available_post_id: ["tt-post-id-555"],
            },
            error: { code: "ok" },
          }),
      ),
    );
    const r = await pollTikTokPublishStatus({
      accessToken: "tok",
      publishId: "pub-id-abc",
      apiBase: API_BASE,
    });
    expect(r.terminal).toBe(true);
    expect(r.status).toBe("published");
    if (r.terminal) {
      expect(r.publicPostId).toBe("tt-post-id-555");
      expect(r.publicUri).toBe(
        "https://www.tiktok.com/video/tt-post-id-555",
      );
    }
  });

  it("maps SEND_TO_USER_INBOX → terminal published (audit path)", async () => {
    server.use(
      http.post(
        `${API_BASE}/v2/post/publish/status/fetch/`,
        () =>
          HttpResponse.json({
            data: { status: "SEND_TO_USER_INBOX" },
            error: { code: "ok" },
          }),
      ),
    );
    const r = await pollTikTokPublishStatus({
      accessToken: "tok",
      publishId: "pub-id-abc",
      apiBase: API_BASE,
    });
    expect(r.terminal).toBe(true);
    expect(r.status).toBe("published");
    if (r.terminal) {
      expect(r.publicPostId).toBeUndefined();
    }
  });

  it("maps FAILED → terminal failed with reason", async () => {
    server.use(
      http.post(
        `${API_BASE}/v2/post/publish/status/fetch/`,
        () =>
          HttpResponse.json({
            data: {
              status: "FAILED",
              fail_reason: "video_resolution_too_low",
            },
            error: { code: "ok" },
          }),
      ),
    );
    const r = await pollTikTokPublishStatus({
      accessToken: "tok",
      publishId: "pub-id-abc",
      apiBase: API_BASE,
    });
    expect(r.terminal).toBe(true);
    expect(r.status).toBe("failed");
    if (r.terminal && r.status === "failed") {
      expect(r.failReason).toBe("video_resolution_too_low");
    }
  });

  it("maps PROCESSING_UPLOAD → non-terminal pending", async () => {
    server.use(
      http.post(
        `${API_BASE}/v2/post/publish/status/fetch/`,
        () =>
          HttpResponse.json({
            data: { status: "PROCESSING_UPLOAD" },
            error: { code: "ok" },
          }),
      ),
    );
    const r = await pollTikTokPublishStatus({
      accessToken: "tok",
      publishId: "pub-id-abc",
      apiBase: API_BASE,
    });
    expect(r.terminal).toBe(false);
    if (!r.terminal) {
      expect(r.upstreamState).toBe("PROCESSING_UPLOAD");
    }
  });
});
