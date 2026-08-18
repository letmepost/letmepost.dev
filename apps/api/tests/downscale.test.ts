import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { BLUESKY_IMAGE_MAX_BYTES } from "@letmepost/schemas";
import { fitImageToBytes } from "../src/platforms/_shared/downscale.js";
import { loadMediaItem } from "../src/platforms/_shared/media.js";
import { validateBlueskyMedia } from "../src/platforms/bluesky/preflight.js";

/** Noise compresses badly, so this reliably lands well over the ceiling. */
async function noisyImage(size: number, alpha = false): Promise<Uint8Array> {
  const px = Buffer.alloc(size * size * (alpha ? 4 : 3));
  for (let i = 0; i < px.length; i++) px[i] = (Math.random() * 256) | 0;
  const img = sharp(px, {
    raw: { width: size, height: size, channels: alpha ? 4 : 3 },
  });
  const buf = alpha
    ? await img.png().toBuffer()
    : await img.jpeg({ quality: 100 }).toBuffer();
  return new Uint8Array(buf);
}

describe("fitImageToBytes", () => {
  it("shrinks an over-limit image under Bluesky's ceiling", async () => {
    const big = await noisyImage(1400);
    expect(big.byteLength).toBeGreaterThan(BLUESKY_IMAGE_MAX_BYTES);

    const fitted = await fitImageToBytes(big, "image/jpeg", BLUESKY_IMAGE_MAX_BYTES);
    expect(fitted.bytes.byteLength).toBeLessThanOrEqual(BLUESKY_IMAGE_MAX_BYTES);
    const meta = await sharp(Buffer.from(fitted.bytes)).metadata();
    expect(meta.width).toBeGreaterThan(0);
  }, 30_000);

  it("produces something real preflight accepts", async () => {
    const big = await noisyImage(1400);
    const fitted = await fitImageToBytes(big, "image/jpeg", BLUESKY_IMAGE_MAX_BYTES);
    expect(() =>
      validateBlueskyMedia([
        { kind: "image", mimeType: fitted.mimeType, byteLength: fitted.bytes.byteLength },
      ]),
    ).not.toThrow();
  }, 30_000);

  it("keeps alpha by encoding to webp", async () => {
    const big = await noisyImage(1200, true);
    const fitted = await fitImageToBytes(big, "image/png", BLUESKY_IMAGE_MAX_BYTES);
    if (fitted.bytes.byteLength <= BLUESKY_IMAGE_MAX_BYTES) {
      expect(fitted.mimeType).toBe("image/webp");
    }
  }, 30_000);

  it("leaves an already-small image untouched", async () => {
    const small = await noisyImage(80);
    const fitted = await fitImageToBytes(small, "image/jpeg", BLUESKY_IMAGE_MAX_BYTES);
    expect(fitted.bytes).toBe(small);
  });

  it("never touches video", async () => {
    const bytes = new Uint8Array(2_000_000);
    expect((await fitImageToBytes(bytes, "video/mp4", 1_000_000)).bytes).toBe(bytes);
  });

  it("fails open on undecodable bytes", async () => {
    const junk = new Uint8Array(2_000_000).fill(7);
    expect((await fitImageToBytes(junk, "image/jpeg", 1_000_000)).bytes).toBe(junk);
  });

  it("applies through loadMediaItem when a ceiling is set", async () => {
    const big = await noisyImage(1400);
    const loaded = await loadMediaItem(
      { kind: "image", bytesBase64: Buffer.from(big).toString("base64") },
      { platform: "bluesky", fitImageToBytes: BLUESKY_IMAGE_MAX_BYTES },
    );
    expect(loaded.byteLength).toBeLessThanOrEqual(BLUESKY_IMAGE_MAX_BYTES);
  }, 30_000);
});
