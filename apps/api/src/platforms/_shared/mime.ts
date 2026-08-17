/**
 * Content-sniffing for media bytes.
 *
 * Every resolver path used to take the mime type on trust — a hard-coded
 * guess for base64, the origin's `Content-Type` for URLs, the stored row for
 * mediaIds — and per-platform preflight then rejected on it. A valid JPEG
 * served as `application/octet-stream` never reached the platform.
 */

/** Longest signature we match, so callers know how much to buffer. */
export const SNIFF_HEADER_BYTES = 12;

/** `null` is a wildcard at that position. */
type Pattern = ReadonlyArray<number | null>;

const SIGNATURES: ReadonlyArray<{
  mimeType: string;
  offset: number;
  pattern: Pattern;
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
  // "RIFF" ???? "WEBP"
  {
    mimeType: "image/webp",
    offset: 0,
    pattern: [
      0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50,
    ],
  },
];

/** ISOBMFF `ftyp` box marker at offset 4; the brand follows at offset 8. */
const FTYP: Pattern = [0x66, 0x74, 0x79, 0x70];

/**
 * `ftyp` alone means "ISO base media container", NOT mp4 — HEIC, AVIF and
 * QuickTime share it. Matching on the box marker alone resolved an iPhone
 * HEIC photo to `video/mp4`, which then picked a `.mp4` S3 extension and
 * produced a preflight error naming a type the user never sent. The brand is
 * what actually discriminates.
 */
const ISOBMFF_BRANDS: Readonly<Record<string, string>> = {
  // Video.
  isom: "video/mp4",
  iso2: "video/mp4",
  iso4: "video/mp4",
  iso5: "video/mp4",
  iso6: "video/mp4",
  mp41: "video/mp4",
  mp42: "video/mp4",
  avc1: "video/mp4",
  dash: "video/mp4",
  mmp4: "video/mp4",
  m4v: "video/mp4",
  qt: "video/quicktime",
  // Still images that also ride in ISOBMFF.
  heic: "image/heic",
  heix: "image/heic",
  heim: "image/heic",
  hesp: "image/heic",
  hevc: "image/heic",
  hevx: "image/heic",
  mif1: "image/heic",
  msf1: "image/heic",
  avif: "image/avif",
  avis: "image/avif",
};

function matches(bytes: Uint8Array, offset: number, pattern: Pattern): boolean {
  if (bytes.byteLength < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i];
    if (expected === null) continue;
    if (bytes[offset + i] !== expected) return false;
  }
  return true;
}

/** Read the 4-byte ISOBMFF brand at offset 8, trimmed of padding. */
function readIsobmffBrand(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 12) return undefined;
  let brand = "";
  for (let i = 8; i < 12; i++) brand += String.fromCharCode(bytes[i]!);
  return brand.replace(/[\s\0]+$/, "").toLowerCase() || undefined;
}

/**
 * Identify `bytes` from its magic number, or `undefined` when the format
 * isn't one we recognise — callers fall back to the declared type rather
 * than guessing. Needs {@link SNIFF_HEADER_BYTES} bytes to be conclusive.
 */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  for (const sig of SIGNATURES) {
    if (matches(bytes, sig.offset, sig.pattern)) return sig.mimeType;
  }
  if (matches(bytes, 4, FTYP)) {
    const brand = readIsobmffBrand(bytes);
    // An unknown brand stays undefined: better to defer to the declared type
    // than to assert a container we can't name.
    return brand ? ISOBMFF_BRANDS[brand] : undefined;
  }
  return undefined;
}

/**
 * The mime type to preflight and upload with. Sniffing wins outright — a
 * wrong declared type is the case that breaks publishes, and the bytes
 * cannot lie about what they are.
 */
export function resolveMimeType(
  bytes: Uint8Array,
  declared: string | undefined,
): string {
  return sniffMimeType(bytes) ?? declared ?? "application/octet-stream";
}
