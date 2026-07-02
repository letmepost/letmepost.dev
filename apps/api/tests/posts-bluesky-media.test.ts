import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApp } from "../src/app.js";
import { seed } from "../src/db/seed.js";
import {
  canRunDbTests,
  closeTestDb,
  getTestDb,
  runInTransaction,
} from "./db/support.js";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(async () => {
  server.close();
  await closeTestDb();
});

const describeIfDb = canRunDbTests ? describe : describe.skip;

// Small base64 payload — exact bytes don't matter since we stub uploadBlob.
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z";

function sessionHandler(did = "did:plc:test") {
  return http.post(
    "https://bsky.social/xrpc/com.atproto.server.createSession",
    () =>
      HttpResponse.json({
        accessJwt: "access",
        refreshJwt: "refresh",
        did,
        handle: "alice.bsky.social",
      }),
  );
}

function uploadBlobOk(size = 1234) {
  let counter = 0;
  return http.post(
    "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
    () => {
      counter++;
      return HttpResponse.json({
        blob: {
          $type: "blob",
          ref: { $link: `bafkreiblob${counter}` },
          mimeType: "image/jpeg",
          size,
        },
      });
    },
  );
}

function createRecordOk(uri: string, cid: string) {
  return http.post(
    "https://bsky.social/xrpc/com.atproto.repo.createRecord",
    () => HttpResponse.json({ uri, cid }),
  );
}

type RecordResult =
  | { uri: string; cid: string }
  | { status: number; body: Record<string, unknown> };

function createRecordSequence(results: RecordResult[]) {
  let i = 0;
  return http.post(
    "https://bsky.social/xrpc/com.atproto.repo.createRecord",
    () => {
      const result = results[Math.min(i, results.length - 1)]!;
      i++;
      if ("status" in result) {
        return HttpResponse.json(result.body, { status: result.status });
      }
      return HttpResponse.json(result);
    },
  );
}

describeIfDb("POST /v1/posts (bluesky, media)", () => {
  it("publishes a post with a single image", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        sessionHandler(),
        uploadBlobOk(),
        createRecordOk("at://did:plc:test/app.bsky.feed.post/main1", "bafy-main"),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "one image",
          media: [
            { kind: "image", bytesBase64: TINY_JPEG_BASE64, altText: "a pixel" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ platform: string; uri?: string; cid?: string }>;
      };
      expect(body.status).toBe("published");
      expect(body.results[0]!.platform).toBe("bluesky");
      expect(body.results[0]!.cid).toBe("bafy-main");
    });
  });

  it("publishes a 4-image carousel", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        sessionHandler(),
        uploadBlobOk(),
        createRecordOk(
          "at://did:plc:test/app.bsky.feed.post/carousel",
          "bafy-carousel",
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "four images",
          media: Array.from({ length: 4 }, () => ({
            kind: "image",
            bytesBase64: TINY_JPEG_BASE64,
          })),
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ cid?: string }>;
      };
      expect(body.status).toBe("published");
      expect(body.results[0]!.cid).toBe("bafy-carousel");
    });
  });

  it("publishes a single video through the video service (poll path)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      let pollCalls = 0;
      server.use(
        sessionHandler(),
        // Service auth mint on the user's PDS — narrow-scoped JWT for the
        // video service. The Bluesky video service identifies as the
        // `did:web:video.bsky.app` audience.
        http.get(
          "https://bsky.social/xrpc/com.atproto.server.getServiceAuth",
          () => HttpResponse.json({ token: "service-auth-jwt" }),
        ),
        // getUploadLimits — best-effort, allow.
        http.get(
          "https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits",
          () =>
            HttpResponse.json({
              canUpload: true,
              remainingDailyVideos: 25,
              remainingDailyBytes: 5_000_000_000,
            }),
        ),
        // Initial upload returns CREATED with a jobId.
        http.post(
          "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo",
          () =>
            HttpResponse.json({
              jobStatus: {
                jobId: "job-123",
                did: "did:plc:test",
                state: "JOB_STATE_CREATED",
              },
            }),
        ),
        // Job status: first call returns IN_PROGRESS, second returns COMPLETED
        // with the blob. Mirrors a typical 1-2-poll transcode for a tiny file.
        http.get(
          "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus",
          () => {
            pollCalls += 1;
            if (pollCalls === 1) {
              return HttpResponse.json({
                jobStatus: {
                  jobId: "job-123",
                  did: "did:plc:test",
                  state: "JOB_STATE_ENCODING_IN_PROGRESS",
                  progress: 50,
                },
              });
            }
            return HttpResponse.json({
              jobStatus: {
                jobId: "job-123",
                did: "did:plc:test",
                state: "JOB_STATE_COMPLETED",
                blob: {
                  $type: "blob",
                  ref: { $link: "bafkreivid" },
                  mimeType: "video/mp4",
                  size: 999,
                },
              },
            });
          },
        ),
        createRecordOk("at://did:plc:test/app.bsky.feed.post/video", "bafy-video"),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "a video",
          media: [
            {
              kind: "video",
              // 8 bytes of zeros. When resolved via bytesBase64, mime defaults
              // to video/mp4 per the publisher heuristic.
              bytesBase64: "AAAAAAAAAAA=",
              altText: "a clip",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ cid?: string }>;
      };
      expect(body.status).toBe("published");
      expect(body.results[0]!.cid).toBe("bafy-video");
      expect(pollCalls).toBeGreaterThanOrEqual(2);
    });
  });

  it("short-circuits when the video service returns COMPLETED on first response (dedupe path)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      let jobStatusCalls = 0;
      server.use(
        sessionHandler(),
        http.get(
          "https://bsky.social/xrpc/com.atproto.server.getServiceAuth",
          () => HttpResponse.json({ token: "service-auth-jwt" }),
        ),
        http.get(
          "https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits",
          () => HttpResponse.json({ canUpload: true }),
        ),
        // Bluesky dedupes identical re-uploads — flips straight to COMPLETED
        // with the blob already attached.
        http.post(
          "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo",
          () =>
            HttpResponse.json({
              jobStatus: {
                jobId: "job-dedupe",
                did: "did:plc:test",
                state: "JOB_STATE_COMPLETED",
                blob: {
                  $type: "blob",
                  ref: { $link: "bafkreivid-dedupe" },
                  mimeType: "video/mp4",
                  size: 999,
                },
              },
            }),
        ),
        http.get(
          "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus",
          () => {
            jobStatusCalls += 1;
            return HttpResponse.json({ jobStatus: {} });
          },
        ),
        createRecordOk(
          "at://did:plc:test/app.bsky.feed.post/dedupe",
          "bafy-dedupe",
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "dedupe video",
          media: [{ kind: "video", bytesBase64: "AAAAAAAAAAA=" }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ cid?: string }>;
      };
      expect(body.status).toBe("published");
      expect(body.results[0]!.cid).toBe("bafy-dedupe");
      expect(jobStatusCalls).toBe(0);
    });
  });

  it("surfaces JOB_STATE_FAILED as platform_rejected with bluesky.video.job_failed", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        sessionHandler(),
        http.get(
          "https://bsky.social/xrpc/com.atproto.server.getServiceAuth",
          () => HttpResponse.json({ token: "service-auth-jwt" }),
        ),
        http.get(
          "https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits",
          () => HttpResponse.json({ canUpload: true }),
        ),
        http.post(
          "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo",
          () =>
            HttpResponse.json({
              jobStatus: {
                jobId: "job-fail",
                did: "did:plc:test",
                state: "JOB_STATE_CREATED",
              },
            }),
        ),
        http.get(
          "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus",
          () =>
            HttpResponse.json({
              jobStatus: {
                jobId: "job-fail",
                did: "did:plc:test",
                state: "JOB_STATE_FAILED",
                error: "TranscodeError",
                message: "Unsupported codec.",
              },
            }),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "bad video",
          media: [{ kind: "video", bytesBase64: "AAAAAAAAAAA=" }],
        }),
      });

      // The transcode fails deep in the video pipeline — inside the publisher,
      // so it lands as a per-target rejection in the 200 batch envelope, not a
      // top-level 5xx.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; rule?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("platform_rejected");
      expect(result.error!.rule).toBe("bluesky.video.job_failed");
    });
  });

  it("rejects when the video service reports the user is out of daily quota", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        sessionHandler(),
        http.get(
          "https://bsky.social/xrpc/com.atproto.server.getServiceAuth",
          () => HttpResponse.json({ token: "service-auth-jwt" }),
        ),
        http.get(
          "https://video.bsky.app/xrpc/app.bsky.video.getUploadLimits",
          () =>
            HttpResponse.json({
              canUpload: false,
              message: "Daily video upload limit reached.",
              remainingDailyVideos: 0,
              remainingDailyBytes: 0,
            }),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "quota out",
          media: [{ kind: "video", bytesBase64: "AAAAAAAAAAA=" }],
        }),
      });

      // The quota probe runs inside the video publisher (needs a network call
      // to getUploadLimits), so it surfaces as a per-target rejection in the
      // 200 batch envelope rather than the atomic top-level preflight.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; rule?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("preflight_failed");
      expect(result.error!.rule).toBe("bluesky.video.quota_exhausted");
    });
  });

  it("rejects 5 images before any upstream call", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      // Intentionally no handlers — a call through would raise unhandled.

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "too many",
          media: Array.from({ length: 5 }, () => ({
            kind: "image",
            bytesBase64: TINY_JPEG_BASE64,
          })),
        }),
      });

      // Image count is a shape-level check — it runs in the atomic top-level
      // preflight before any persistence or upstream call, so the whole batch
      // is rejected with a top-level 400.
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("preflight_failed");
      expect(body.error.rule).toBe("bluesky.media.count_max");
    });
  });

  it("rejects mixing images and video", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "mixed",
          media: [
            { kind: "image", bytesBase64: TINY_JPEG_BASE64 },
            { kind: "video", bytesBase64: "AAAA" },
          ],
        }),
      });

      // image/video exclusivity is a shape-level check — atomic top-level
      // preflight rejects the batch before persistence.
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("preflight_failed");
      expect(body.error.rule).toBe("bluesky.media.image_video_exclusive");
    });
  });

  it("rejects an oversized image", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      // 1.1 MB image: base64 of 1_100_000 bytes.
      const bigBytes = new Uint8Array(1_100_000);
      const bigBase64 = Buffer.from(bigBytes).toString("base64");

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "big image",
          media: [{ kind: "image", bytesBase64: bigBase64 }],
        }),
      });

      // Byte-size caps need resolved bytes, so they run inside the publisher —
      // this is a per-target rejection in the 200 batch envelope. No upstream
      // handlers are registered; the decode-then-size check fails before any
      // network call.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; rule?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("preflight_failed");
      expect(result.error!.rule).toBe("bluesky.media.image_size_max");
    });
  });

  it("rejects an oversized video (fetched via URL)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      const bigVideo = new Uint8Array(101_000_000);
      server.use(
        http.get("https://example.test/big.mp4", () =>
          HttpResponse.arrayBuffer(bigVideo.buffer, {
            headers: { "Content-Type": "video/mp4" },
          }),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "huge video",
          media: [{ kind: "video", url: "https://example.test/big.mp4" }],
        }),
      });

      // URL fetch + byte-size cap run inside the publisher, so this is a
      // per-target rejection in the 200 batch envelope.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; rule?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("preflight_failed");
      expect(result.error!.rule).toBe("bluesky.media.video_size_max");
    });
  });

  it("rejects a bad image mime type (fetched via URL)", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        http.get("https://example.test/bad.heic", () =>
          HttpResponse.arrayBuffer(new Uint8Array(10).buffer, {
            headers: { "Content-Type": "image/heic" },
          }),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "bad mime",
          media: [{ kind: "image", url: "https://example.test/bad.heic" }],
        }),
      });

      // MIME sniffing needs the resolved bytes, so it runs inside the publisher
      // — per-target rejection in the 200 batch envelope.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; rule?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("preflight_failed");
      expect(result.error!.rule).toBe("bluesky.media.mime_allowed");
    });
  });

  it("rejects overlong alt text", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "alt too long",
          media: [
            {
              kind: "image",
              bytesBase64: TINY_JPEG_BASE64,
              altText: "a".repeat(2001),
            },
          ],
        }),
      });

      // Alt-text length is a shape-level check (no bytes needed), so it runs in
      // the atomic top-level preflight and rejects the batch with a 400.
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; rule?: string };
      };
      expect(body.error.code).toBe("preflight_failed");
      expect(body.error.rule).toBe("bluesky.media.alt_text_max_graphemes");
    });
  });

  it("surfaces uploadBlob 413 as platform_rejected", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        sessionHandler(),
        http.post(
          "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
          () =>
            HttpResponse.json(
              { error: "PayloadTooLarge", message: "blob too large" },
              { status: 413 },
            ),
        ),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "will fail upload",
          media: [{ kind: "image", bytesBase64: TINY_JPEG_BASE64 }],
        }),
      });

      // uploadBlob 413 is an upstream rejection inside the publisher — it lands
      // as a per-target rejection in the 200 batch envelope. The target-level
      // `platform` echoes bluesky; the raw upstream body rides in
      // `error.platformResponse`.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          platform: string;
          status: string;
          error?: { code: string; platformResponse?: unknown };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.platform).toBe("bluesky");
      expect(result.error!.code).toBe("platform_rejected");
      expect(result.error!.platformResponse).toMatchObject({
        error: "PayloadTooLarge",
      });
    });
  });
});

describeIfDb("POST /v1/posts (bluesky, first comment)", () => {
  it("publishes a text-only post with a first-comment reply", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        sessionHandler(),
        createRecordSequence([
          { uri: "at://did:plc:test/app.bsky.feed.post/main", cid: "bafy-main" },
          { uri: "at://did:plc:test/app.bsky.feed.post/reply", cid: "bafy-reply" },
        ]),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "main thread",
          firstComment: { text: "follow-up comment" },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          cid?: string;
          firstCommentUri?: string;
          firstCommentCid?: string;
        }>;
      };
      expect(body.status).toBe("published");
      const result = body.results[0]!;
      expect(result.cid).toBe("bafy-main");
      expect(result.firstCommentUri).toMatch(/app\.bsky\.feed\.post\/reply/);
      expect(result.firstCommentCid).toBe("bafy-reply");
    });
  });

  it("publishes an image post with a first-comment reply", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        sessionHandler(),
        uploadBlobOk(),
        createRecordSequence([
          { uri: "at://did:plc:test/app.bsky.feed.post/m", cid: "bafy-m" },
          { uri: "at://did:plc:test/app.bsky.feed.post/r", cid: "bafy-r" },
        ]),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "photo",
          media: [{ kind: "image", bytesBase64: TINY_JPEG_BASE64 }],
          firstComment: { text: "source link in replies" },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{ firstCommentCid?: string }>;
      };
      expect(body.status).toBe("published");
      expect(body.results[0]!.firstCommentCid).toBe("bafy-r");
    });
  });

  it("rejects an empty first-comment text", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "main",
          firstComment: { text: "   " },
        }),
      });

      // First-comment validation runs inside the publisher (not in the atomic
      // shape preflight), so an empty comment is a per-target rejection in the
      // 200 batch envelope. It fails before the session is created, so no
      // upstream handlers are needed.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; rule?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("preflight_failed");
      expect(result.error!.rule).toBe("bluesky.first_comment.non_empty");
    });
  });

  it("rejects an over-300-grapheme first-comment", async () => {
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "main",
          firstComment: { text: "a".repeat(301) },
        }),
      });

      // First-comment length is validated inside the publisher, so an
      // over-limit comment is a per-target rejection in the 200 batch envelope.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          error?: { code: string; rule?: string };
        }>;
      };
      expect(body.status).toBe("failed");
      const result = body.results[0]!;
      expect(result.status).toBe("rejected");
      expect(result.error!.code).toBe("preflight_failed");
      expect(result.error!.rule).toBe("bluesky.first_comment.max_graphemes");
    });
  });

  it("returns the main post with a warning when the first-comment reply fails", async () => {
    // Design choice: if the main post is already live on the PDS, we do NOT
    // roll back or fail the request. The user's content is published. We
    // surface the first-comment failure as a non-fatal warning under
    // `warnings[].code = "first_comment_failed"` so the caller can retry the
    // reply independently. A hard failure here would be lossy — we can't
    // un-publish.
    const { db } = await getTestDb();
    await runInTransaction(db, async (tx) => {
      const fixture = await seed(tx);
      server.use(
        sessionHandler(),
        createRecordSequence([
          { uri: "at://did:plc:test/app.bsky.feed.post/ok", cid: "bafy-ok" },
          {
            status: 400,
            body: { error: "InvalidRequest", message: "reply blocked" },
          },
        ]),
      );

      const app = createApp({ db: tx });
      const res = await app.request("/v1/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fixture.apiKey.plaintext}`,
        },
        body: JSON.stringify({
          targets: [{ accountId: fixture.accountId }],
          text: "main ok",
          firstComment: { text: "reply will fail" },
        }),
      });

      // The main post is live, so the target still counts as published; the
      // first-comment failure rides along as a non-fatal per-target warning.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        results: Array<{
          status: string;
          cid?: string;
          firstCommentCid?: string;
          warnings?: Array<{ code: string }>;
        }>;
      };
      expect(body.status).toBe("published");
      const result = body.results[0]!;
      expect(result.status).toBe("published");
      expect(result.cid).toBe("bafy-ok");
      expect(result.firstCommentCid).toBeUndefined();
      expect(result.warnings?.[0]?.code).toBe("first_comment_failed");
    });
  });
});
