import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { loadMediaItem } from "../src/platforms/_shared/media.js";
import { resolveMimeType, sniffMimeType } from "../src/platforms/_shared/mime.js";
import { validateTwitterMedia } from "../src/platforms/twitter/preflight.js";

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

/** Minimal byte headers — enough for the magic-number check, not real files. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);

describe("sniffMimeType", () => {
  it("identifies the formats the platforms accept", () => {
    expect(sniffMimeType(PNG)).toBe("image/png");
    expect(sniffMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffMimeType(GIF)).toBe("image/gif");
    expect(sniffMimeType(WEBP)).toBe("image/webp");
    expect(sniffMimeType(MP4)).toBe("video/mp4");
  });

  it("returns undefined for bytes it doesn't recognise", () => {
    expect(sniffMimeType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
    expect(sniffMimeType(new Uint8Array([]))).toBeUndefined();
  });

  it("keeps the declared type only when the bytes are unrecognisable", () => {
    expect(resolveMimeType(PNG, "application/octet-stream")).toBe("image/png");
    expect(resolveMimeType(new Uint8Array([1, 2, 3]), "image/heic")).toBe(
      "image/heic",
    );
  });
});

describe("loadMediaItem — mime is taken from the bytes, not the label", () => {
  it("does not label base64 PNG bytes as image/jpeg", async () => {
    const loaded = await loadMediaItem({
      kind: "image",
      bytesBase64: Buffer.from(PNG).toString("base64"),
    });
    expect(loaded.mimeType).toBe("image/png");
  });

  it("recovers a valid image served as application/octet-stream", async () => {
    // The exact report from the field: an object store handing back a generic
    // Content-Type made preflight reject a file X itself accepts.
    server.use(
      http.get("https://cdn.example/photo", () =>
        HttpResponse.arrayBuffer(JPEG.buffer as ArrayBuffer, {
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    );
    const loaded = await loadMediaItem({
      kind: "image",
      url: "https://cdn.example/photo",
    });
    expect(loaded.mimeType).toBe("image/jpeg");
    expect(() =>
      validateTwitterMedia([
        {
          kind: "image",
          mimeType: loaded.mimeType,
          byteLength: loaded.byteLength,
        },
      ]),
    ).not.toThrow();
  });

  it("corrects a wrong Content-Type rather than trusting it", async () => {
    server.use(
      http.get("https://cdn.example/mislabelled", () =>
        HttpResponse.arrayBuffer(WEBP.buffer as ArrayBuffer, {
          headers: { "content-type": "image/jpeg" },
        }),
      ),
    );
    const loaded = await loadMediaItem({
      kind: "image",
      url: "https://cdn.example/mislabelled",
    });
    expect(loaded.mimeType).toBe("image/webp");
  });

  it("still rejects a format X genuinely does not accept", async () => {
    server.use(
      http.get("https://cdn.example/doc", () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
          headers: { "content-type": "application/pdf" },
        }),
      ),
    );
    const loaded = await loadMediaItem({
      kind: "image",
      url: "https://cdn.example/doc",
    });
    expect(() =>
      validateTwitterMedia([
        {
          kind: "image",
          mimeType: loaded.mimeType,
          byteLength: loaded.byteLength,
        },
      ]),
    ).toThrowError(/not allowed on X/);
  });
});
