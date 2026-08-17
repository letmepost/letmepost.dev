/**
 * Content-sniffing for media bytes.
 *
 * Every path that produced a `LoadedMediaItem` used to take the mime type on
 * trust: the base64 path hard-coded `image/jpeg` for anything tagged
 * `kind: "image"`, the URL path echoed whatever `Content-Type` the origin
 * sent, and the `mediaId` path echoed the `media` row's stored contentType
 * (itself just the multipart part header, defaulting to
 * `application/octet-stream`).
 *
 * That is the wrong source of truth. Per-platform preflight rejects on mime
 * (`twitter.media.mime_allowed`, etc.), so a perfectly valid PNG served by a
 * CDN as `application/octet-stream` — or uploaded through a client that
 * omitted the part's Content-Type — got rejected before it ever reached the
 * platform, while the identical file uploaded by hand to X went through fine.
 *
 * The bytes are already in memory at the point preflight runs, so sniff them
 * and let the magic number win. The declared type stays as the fallback for
 * formats we don't have a signature for.
 */

/** Formats we can positively identify, and that some platform accepts. */
const SIGNATURES: ReadonlyArray<{
  mimeType: string;
  /** Byte offset the pattern starts at. */
  offset: number;
  /** Bytes to match; `null` is a wildcard for that position. */
  pattern: ReadonlyArray<number | null>;
}> = [
  { mimeType: "image/jpeg", offset: 0, pattern: [0xff, 0xd8, 0xff] },
  {
    mimeType: "image/png",
    offset: 0,
    pattern: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // "GIF87a" / "GIF89a"
  {
    mimeType: "image/gif",
    offset: 0,
    pattern: [0x47, 0x49, 0x46, 0x38, null, 0x61],
  },
  // "RIFF" .... "WEBP" — the 4 size bytes at offset 4 are the wildcards.
  {
    mimeType: "image/webp",
    offset: 0,
    pattern: [
      0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50,
    ],
  },
  // ISO base media file format: "ftyp" box at offset 4. Covers mp4 / m4v and
  // the QuickTime brands platforms accept under the video/mp4 umbrella.
  { mimeType: "video/mp4", offset: 4, pattern: [0x66, 0x74, 0x79, 0x70] },
];

function matches(
  bytes: Uint8Array,
  offset: number,
  pattern: ReadonlyArray<number | null>,
): boolean {
  if (bytes.byteLength < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i];
    if (expected === null) continue;
    if (bytes[offset + i] !== expected) return false;
  }
  return true;
}

/**
 * Identify `bytes` from its magic number. Returns `undefined` when the format
 * isn't one we have a signature for — callers fall back to the declared type
 * rather than guessing.
 */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  for (const sig of SIGNATURES) {
    if (matches(bytes, sig.offset, sig.pattern)) return sig.mimeType;
  }
  return undefined;
}

/**
 * Pick the mime type to preflight and upload with: the sniffed type when we
 * recognise the bytes, otherwise the declared one.
 *
 * Sniffing wins outright rather than only filling in blanks — a wrong
 * declared type (`image/jpeg` on PNG bytes from the base64 path, or a CDN
 * serving `application/octet-stream`) is exactly the case that was breaking
 * publishes, and the bytes cannot lie about what they are.
 */
export function resolveMimeType(
  bytes: Uint8Array,
  declared: string | undefined,
): string {
  return sniffMimeType(bytes) ?? declared ?? "application/octet-stream";
}
