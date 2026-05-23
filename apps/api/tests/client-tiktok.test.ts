import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { TikTokClient } from "../src/platforms/tiktok/client.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API_BASE = "https://test.example/tiktok-api";

describe("TikTokClient.getUserInfo", () => {
  it("returns the wrapped data.user payload on success", async () => {
    server.use(
      http.get(`${API_BASE}/v2/user/info/`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("fields")).toContain("open_id");
        return HttpResponse.json({
          data: {
            user: { open_id: "abc", display_name: "Alice", username: "alice" },
          },
          error: { code: "ok" },
        });
      }),
    );
    const client = new TikTokClient("tok", API_BASE);
    const info = await client.getUserInfo();
    expect(info.open_id).toBe("abc");
    expect(info.display_name).toBe("Alice");
  });

  it("maps 401 to platform_auth_failed", async () => {
    server.use(
      http.get(
        `${API_BASE}/v2/user/info/`,
        () =>
          HttpResponse.json(
            { error: { code: "access_token_invalid", message: "bad" } },
            { status: 401 },
          ),
      ),
    );
    const client = new TikTokClient("tok", API_BASE);
    await expect(client.getUserInfo()).rejects.toMatchObject({
      code: "platform_auth_failed",
    });
  });

  it("maps envelope error.code=access_token_invalid on 200 to platform_auth_failed", async () => {
    server.use(
      http.get(
        `${API_BASE}/v2/user/info/`,
        () =>
          HttpResponse.json({
            error: { code: "access_token_invalid", message: "bad" },
          }),
      ),
    );
    const client = new TikTokClient("tok", API_BASE);
    await expect(client.getUserInfo()).rejects.toMatchObject({
      code: "platform_auth_failed",
    });
  });

  it("maps 429 to platform_rejected with rate-limited rule", async () => {
    server.use(
      http.get(
        `${API_BASE}/v2/user/info/`,
        () =>
          HttpResponse.json(
            { error: { code: "rate_limit_exceeded", message: "slow down" } },
            { status: 429 },
          ),
      ),
    );
    const client = new TikTokClient("tok", API_BASE);
    await expect(client.getUserInfo()).rejects.toMatchObject({
      code: "platform_rejected",
      rule: "tiktok.rate_limited",
    });
  });
});

describe("TikTokClient.queryCreatorInfo", () => {
  it("returns the wrapped data payload on success", async () => {
    server.use(
      http.post(
        `${API_BASE}/v2/post/publish/creator_info/query/`,
        () =>
          HttpResponse.json({
            data: {
              privacy_level_options: ["SELF_ONLY"],
              creator_username: "alice",
            },
            error: { code: "ok" },
          }),
      ),
    );
    const client = new TikTokClient("tok", API_BASE);
    const info = await client.queryCreatorInfo();
    expect(info.privacy_level_options).toEqual(["SELF_ONLY"]);
    expect(info.creator_username).toBe("alice");
  });
});

describe("TikTokClient.initInboxUpload", () => {
  it("sends source FILE_UPLOAD + chunk metadata", async () => {
    server.use(
      http.post(
        `${API_BASE}/v2/post/publish/inbox/video/init/`,
        async ({ request }) => {
          const body = (await request.json()) as {
            source_info?: {
              source?: string;
              video_size?: number;
              chunk_size?: number;
              total_chunk_count?: number;
            };
          };
          expect(body.source_info?.source).toBe("FILE_UPLOAD");
          expect(body.source_info?.video_size).toBe(1024 * 1024);
          expect(body.source_info?.chunk_size).toBe(1024 * 1024);
          expect(body.source_info?.total_chunk_count).toBe(1);
          return HttpResponse.json({
            data: {
              publish_id: "pub-id",
              upload_url: "https://test.example/u",
            },
            error: { code: "ok" },
          });
        },
      ),
    );
    const client = new TikTokClient("tok", API_BASE);
    const out = await client.initInboxUpload({
      videoSize: 1024 * 1024,
      chunkSize: 1024 * 1024,
      totalChunkCount: 1,
    });
    expect(out.publish_id).toBe("pub-id");
    expect(out.upload_url).toBe("https://test.example/u");
  });
});
