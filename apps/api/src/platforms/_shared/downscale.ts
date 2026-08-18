import sharp from "sharp";

/**
 * Shrink an image to fit a platform's byte ceiling.
 *
 * The same image goes to every target, but the ceilings differ by 5x or more
 * (Bluesky ~976 KB, X 5 MB, Threads 8 MB). Without this the user has to
 * hand-optimise for the strictest platform, which is the work they're paying
 * us to avoid.
 *
 * Fails open: any error returns the original bytes so per-platform preflight
 * still rejects with its normal message. Shrinking is an optimisation, never
 * a new failure mode.
 */

/** Quality ladder tried before touching dimensions. */
const QUALITY_STEPS = [82, 70, 58, 46] as const;
/** Dimension passes after quality is exhausted; each scales the longest edge. */
const SCALE_STEPS = [0.8, 0.64, 0.5, 0.4] as const;

export type FittedImage = { bytes: Uint8Array; mimeType: string };

function encoder(
  pipeline: sharp.Sharp,
  hasAlpha: boolean,
  quality: number,
): { out: sharp.Sharp; mimeType: string } {
  // WebP keeps alpha and beats PNG substantially at these sizes; JPEG is the
  // safest bet everywhere else. Both are accepted by every platform that has
  // an image ceiling worth fitting to.
  return hasAlpha
    ? { out: pipeline.webp({ quality }), mimeType: "image/webp" }
    : { out: pipeline.jpeg({ quality, mozjpeg: true }), mimeType: "image/jpeg" };
}

export async function fitImageToBytes(
  bytes: Uint8Array,
  mimeType: string,
  maxBytes: number,
): Promise<FittedImage> {
  const original = { bytes, mimeType };
  if (!mimeType.startsWith("image/")) return original;
  if (bytes.byteLength <= maxBytes) return original;

  try {
    const input = Buffer.from(bytes);
    const meta = await sharp(input).metadata();

    // Animated GIFs and multi-page images lose their animation on re-encode.
    // Leave them alone and let preflight reject if they're too big.
    if ((meta.pages ?? 1) > 1) return original;
    if (!meta.width || !meta.height) return original;

    const hasAlpha = meta.hasAlpha === true;
    const longest = Math.max(meta.width, meta.height);

    for (const scale of [1, ...SCALE_STEPS]) {
      const base =
        scale === 1
          ? sharp(input)
          : sharp(input).resize({
              width: Math.max(320, Math.round(longest * scale)),
              height: Math.max(320, Math.round(longest * scale)),
              fit: "inside",
              withoutEnlargement: true,
            });

      for (const quality of QUALITY_STEPS) {
        const { out, mimeType: outMime } = encoder(base.clone(), hasAlpha, quality);
        const buf = await out.toBuffer();
        if (buf.byteLength <= maxBytes) {
          return { bytes: new Uint8Array(buf), mimeType: outMime };
        }
      }
    }
    return original;
  } catch {
    return original;
  }
}
