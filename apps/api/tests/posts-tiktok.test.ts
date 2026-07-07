import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Scale TikTok's chunk constants down (KiB instead of MiB) so the chunking
// algorithm can be exercised end-to-end without allocating 64+ MiB buffers.
// The chunk math is scale-invariant: the ratios (10 KiB chunk / 64 KiB
// single-chunk threshold) mirror production (10 MiB / 64 MiB). Every other
// schema export stays real via the spread.
const { MOCK_CHUNK_SIZE, MOCK_SINGLE_THRESHOLD } = vi.hoisted(() => ({
  MOCK_CHUNK_SIZE: 10 * 1024,
  MOCK_SINGLE_THRESHOLD: 64 * 1024,
}));
vi.mock("@letmepost/schemas", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@letmepost/schemas")>();
  return {
    ...actual,
    TIKTOK_CHUNK_SIZE_BYTES: MOCK_CHUNK_SIZE,
    TIKTOK_SINGLE_CHUNK_THRESHOLD_BYTES: MOCK_SINGLE_THRESHOLD,
  };
});

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

function sizedVideoHandler(url: string, size: number) {
  return http.get(
    url,
    () =>
      new HttpResponse(new Uint8Array(size), {
        headers: { "Content-Type": "video/mp4" },
      }),
  );
}

type InitCapture = { source_info?: Record<string, unknown> | undefined };

function recordingInitHandler(capture: InitCapture) {
  return http.post(
    `${API_BASE}/v2/post/publish/inbox/video/init/`,
    async ({ request }) => {
      const body = (await request.json()) as {
        source_info?: Record<string, unknown>;
      };
      capture.source_info = body.source_info;
      return HttpResponse.json({
        data: { publish_id: "pub-id-chunked", upload_url: UPLOAD_URL },
        error: { code: "ok" },
      });
    },
  );
}

type PutRecord = { range: string | null; size: number; contentLength: string | null };

function recordingUploadHandler(records: PutRecord[]) {
  return http.put(UPLOAD_URL, async ({ request }) => {
    const buf = await request.arrayBuffer();
    records.push({
      range: request.headers.get("content-range"),
      size: buf.byteLength,
      contentLength: request.headers.get("content-length"),
    });
    return new HttpResponse(null, { status: 201 });
  });
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

  it("multi-chunk: uses floor(size/chunk) and the final chunk absorbs the remainder", async () => {
    // Size that is NOT a clean multiple of the chunk size, chosen so the
    // remainder (1024 B) is below the 5 KiB min-chunk floor. Under the old
    // Math.ceil logic this produced an 8th, undersized 1 KiB chunk that
    // TikTok rejects; floor + final-chunk-absorbs-remainder must instead
    // emit 7 chunks with an 11 KiB final chunk.
    const totalBytes = 7 * MOCK_CHUNK_SIZE + 1024; // 72704
    const expectedChunks = Math.floor(totalBytes / MOCK_CHUNK_SIZE); // 7
    const url = "https://example.com/big.mp4";
    const init: InitCapture = {};
    const puts: PutRecord[] = [];
    server.use(
      recordingInitHandler(init),
      recordingUploadHandler(puts),
      sizedVideoHandler(url, totalBytes),
    );

    const result = await tiktokPublisher.publish(
      {
        accessToken: "tok",
        apiBase: API_BASE,
        auditState: "audit",
        privacyLevelOptions: ["SELF_ONLY"],
      },
      {
        text: "big video",
        media: [{ kind: "video", url }],
      },
    );
    expect(result.status).toBe("publishing");

    // init/ contract: floor count, real chunk size, honest video size.
    expect(init.source_info?.chunk_size).toBe(MOCK_CHUNK_SIZE);
    expect(init.source_info?.total_chunk_count).toBe(expectedChunks);
    expect(init.source_info?.video_size).toBe(totalBytes);

    // One PUT per counted chunk — never an extra undersized trailing chunk.
    expect(puts).toHaveLength(expectedChunks);

    // Every chunk except the last is exactly chunk_size; the final chunk
    // carries the remainder and is therefore >= chunk_size, never below it.
    const expectedRanges: string[] = [];
    let covered = 0;
    for (let i = 0; i < expectedChunks; i++) {
      const start = i * MOCK_CHUNK_SIZE;
      const end = i === expectedChunks - 1 ? totalBytes : start + MOCK_CHUNK_SIZE;
      expectedRanges.push(`bytes ${start}-${end - 1}/${totalBytes}`);
      expect(puts[i]!.size).toBe(end - start);
      expect(puts[i]!.contentLength).toBe(String(end - start));
      expect(puts[i]!.size).toBeGreaterThanOrEqual(MOCK_CHUNK_SIZE);
      covered += end - start;
    }
    // Content-Range headers are contiguous and cover the whole file exactly.
    expect(puts.map((p) => p.range)).toEqual(expectedRanges);
    expect(covered).toBe(totalBytes);
    // The final chunk is strictly larger than a single chunk (absorbed remainder).
    expect(puts.at(-1)!.size).toBe(totalBytes - (expectedChunks - 1) * MOCK_CHUNK_SIZE);
    expect(puts.at(-1)!.size).toBeGreaterThan(MOCK_CHUNK_SIZE);
  });

  it("single-chunk: a file at/under the threshold uploads whole in one PUT", async () => {
    const totalBytes = MOCK_SINGLE_THRESHOLD; // exactly the threshold → single
    const url = "https://example.com/at-threshold.mp4";
    const init: InitCapture = {};
    const puts: PutRecord[] = [];
    server.use(
      recordingInitHandler(init),
      recordingUploadHandler(puts),
      sizedVideoHandler(url, totalBytes),
    );

    await tiktokPublisher.publish(
      {
        accessToken: "tok",
        apiBase: API_BASE,
        auditState: "audit",
        privacyLevelOptions: ["SELF_ONLY"],
      },
      { text: "small", media: [{ kind: "video", url }] },
    );

    expect(init.source_info?.total_chunk_count).toBe(1);
    expect(init.source_info?.chunk_size).toBe(totalBytes);
    expect(init.source_info?.video_size).toBe(totalBytes);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.range).toBe(`bytes 0-${totalBytes - 1}/${totalBytes}`);
    expect(puts[0]!.size).toBe(totalBytes);
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
