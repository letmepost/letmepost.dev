import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { MediaInput } from "@letmepost/schemas";
import type { DrizzleClient } from "../../db/index.js";
import { LetmepostError } from "../../errors.js";
import {
  buildPublicUrl,
  getPublicBaseUrl,
} from "../../media/s3.js";
import { DrizzleMediaRepository } from "../../repositories/media.js";

const MAX_URL_FETCH_BYTES = 4 * 1024 * 1024 * 1024;

// Residual limitation: DNS-validated IPs can differ from what `fetch` finally
// connects to (DNS rebinding / TOCTOU); global `fetch` exposes no socket pin.
async function assertUrlIsFetchable(
  rawUrl: string,
  opts: LoadMediaOptions,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: `Media URL is not a valid URL: ${rawUrl}`,
      ...(opts.platform ? { platform: opts.platform } : {}),
      remediation: "Provide an absolute http(s) URL, or inline via bytesBase64.",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: `Unsupported media URL scheme '${parsed.protocol}'.`,
      ...(opts.platform ? { platform: opts.platform } : {}),
      remediation: "Only http(s) media URLs are accepted.",
    });
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  const lowerHost = hostname.toLowerCase();
  if (lowerHost === "localhost" || lowerHost.endsWith(".localhost")) {
    throwBlocked(rawUrl, opts);
  }

  const ipsToCheck: string[] = [];
  if (isIP(hostname) !== 0) {
    ipsToCheck.push(hostname);
  } else {
    let resolved: { address: string }[];
    try {
      resolved = await lookup(hostname, { all: true });
    } catch {
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 503,
        message: `Could not resolve media URL host '${hostname}'.`,
        ...(opts.platform ? { platform: opts.platform } : {}),
        remediation:
          "Verify the media URL host is publicly resolvable, or inline via bytesBase64.",
      });
    }
    if (resolved.length === 0) throwBlocked(rawUrl, opts);
    for (const r of resolved) ipsToCheck.push(r.address);
  }

  for (const ip of ipsToCheck) {
    if (isBlockedAddress(ip)) throwBlocked(rawUrl, opts);
  }
}

function throwBlocked(rawUrl: string, opts: LoadMediaOptions): never {
  throw new LetmepostError({
    code: "validation_failed",
    status: 400,
    message: `Media URL host is not allowed: ${rawUrl}`,
    ...(opts.platform ? { platform: opts.platform } : {}),
    remediation:
      "Media URLs must point at a public host. Internal / private addresses are blocked; inline via bytesBase64 instead.",
  });
}

function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIPv4(ip);
  if (kind === 6) return isBlockedIPv6(ip);
  return true;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
  if (lower.startsWith("fe80")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

async function readBoundedBody(
  res: Response,
  maxBytes: number,
  rawUrl: string,
  opts: LoadMediaOptions,
): Promise<Uint8Array> {
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throwTooLarge(rawUrl, maxBytes, opts);
    }
  }

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throwTooLarge(rawUrl, maxBytes, opts);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throwTooLarge(rawUrl, maxBytes, opts);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function throwTooLarge(
  rawUrl: string,
  maxBytes: number,
  opts: LoadMediaOptions,
): never {
  throw new LetmepostError({
    code: "preflight_failed",
    status: 400,
    message: `Media at ${rawUrl} exceeds the maximum download size of ${maxBytes} bytes.`,
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.reachableRule ? { rule: opts.reachableRule } : {}),
    remediation: `Host media under ${maxBytes} bytes, or inline via bytesBase64.`,
  });
}

/**
 * A `MediaInput` resolved to actual bytes + a definite mime type. Preflight
 * size checks run on this shape — never on the URL or base64 string — so
 * the byte count is honest regardless of how the caller supplied the media.
 */
export type LoadedMediaItem = {
  kind: "image" | "video";
  mimeType: string;
  byteLength: number;
  bytes: Uint8Array;
  altText?: string;
};

/**
 * Tenancy context required to resolve `mediaId`-shaped inputs. Threaded from
 * the posts route → dispatcher → publisher → resolver. URL/base64 inputs
 * don't need it.
 */
export type MediaResolverContext = {
  db: DrizzleClient;
  organizationId: string;
  profileId: string;
};

export type LoadMediaOptions = {
  /**
   * Platform tag stamped on errors so the user gets a `platform` field on the
   * error response (helps the dashboard's Post Log filter by platform).
   */
  platform?: string;
  /**
   * Rule slug for the "URL returned non-2xx" preflight failure. Each
   * platform owns its own rule namespace — e.g. `twitter.media.reachable`,
   * `bluesky.media.reachable`. Falls back to a generic message if omitted.
   */
  reachableRule?: string;
  /**
   * DB client + tenancy context required to resolve the `mediaId` variant.
   * Omitting these makes `mediaId`-shaped inputs fail loudly — keeps tests
   * that don't exercise the new path from silently no-oping.
   */
  db?: DrizzleClient;
  organizationId?: string;
  profileId?: string;
};

/**
 * Resolve a `MediaInput` into bytes + mime type. Errors are mapped to the
 * canonical `LetmepostError` contract so callers never have to re-translate.
 *
 *   - mediaId          → load the `media` row scoped to org+profile, then
 *                        fetch the bytes from the public S3 URL. Cross-tenant
 *                        ids 404. Missing creds / unknown id → 404.
 *   - inline base64    → decoded; mime defaults to `image/jpeg` or
 *                        `video/mp4` based on `kind` (caller usually owns
 *                        the actual mime via the platform's preflight)
 *   - URL              → fetched; on non-2xx → `preflight_failed`; on
 *                        network failure → `platform_unavailable`
 *   - none of the above → `validation_failed` (Zod refinement should catch
 *                         this; loud fallback)
 */
export async function loadMediaItem(
  item: MediaInput,
  opts: LoadMediaOptions = {},
): Promise<LoadedMediaItem> {
  if (item.mediaId) {
    return loadFromMediaId(item, opts);
  }
  if (item.bytesBase64) {
    const bytes = Uint8Array.from(Buffer.from(item.bytesBase64, "base64"));
    const mimeType =
      item.kind === "image" ? "image/jpeg" : "video/mp4";
    return withAlt(
      { kind: item.kind, mimeType, byteLength: bytes.byteLength, bytes },
      item.altText,
    );
  }

  if (!item.url) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: "Media item must provide 'mediaId', 'url', or 'bytesBase64'.",
      ...(opts.platform ? { platform: opts.platform } : {}),
    });
  }

  await assertUrlIsFetchable(item.url, opts);

  let res: Response;
  try {
    res = await fetch(item.url);
  } catch {
    throw new LetmepostError({
      code: "platform_unavailable",
      status: 503,
      message: `Failed to fetch media from ${item.url}.`,
      ...(opts.platform ? { platform: opts.platform } : {}),
      remediation:
        "Verify the media URL is publicly reachable, or inline via bytesBase64.",
    });
  }
  if (!res.ok) {
    throw new LetmepostError({
      code: "preflight_failed",
      status: 400,
      message: `Media URL returned ${res.status}: ${item.url}`,
      ...(opts.platform ? { platform: opts.platform } : {}),
      ...(opts.reachableRule ? { rule: opts.reachableRule } : {}),
      remediation:
        "Ensure the URL is public and returns 200, or inline via bytesBase64.",
    });
  }

  const bytes = await readBoundedBody(res, MAX_URL_FETCH_BYTES, item.url, opts);
  const contentType = res.headers.get("content-type");
  const mimeType = contentType
    ? contentType.split(";")[0]!.trim().toLowerCase()
    : item.kind === "image"
      ? "image/jpeg"
      : "video/mp4";

  return withAlt(
    { kind: item.kind, mimeType, byteLength: bytes.byteLength, bytes },
    item.altText,
  );
}

function withAlt(
  base: Omit<LoadedMediaItem, "altText">,
  altText: string | undefined,
): LoadedMediaItem {
  return altText !== undefined ? { ...base, altText } : base;
}

/**
 * Like `loadMediaItem`, but returns only the resolved public URL — no byte
 * fetch. For platforms that pass a URL upstream rather than uploading bytes
 * (Pinterest, Meta image / Reels source).
 *
 *   - mediaId      → load row, build URL from `s3Key`. mimeType comes from
 *                    the row's `contentType` so per-platform mime preflight
 *                    is honest without a HEAD round-trip.
 *   - url          → passthrough; mimeType undefined (caller's preflight
 *                    HEADs the URL if it needs to know).
 *   - bytesBase64  → preflight_failed: bytes-inline doesn't make sense for
 *                    URL-consuming platforms. Direct callers to /v1/media.
 */
export type ResolvedMediaUrl = {
  kind: "image" | "video";
  url: string;
  /** Known when the source was a `mediaId` (we control the row); undefined for raw URL. */
  mimeType?: string;
  altText?: string;
};

export async function resolveMediaToUrl(
  item: MediaInput,
  opts: LoadMediaOptions = {},
): Promise<ResolvedMediaUrl> {
  if (item.mediaId) {
    if (!opts.db || !opts.organizationId || !opts.profileId) {
      throw new LetmepostError({
        code: "internal_error",
        status: 500,
        message:
          "Media resolver called without db/organizationId/profileId for a mediaId-shaped input.",
        ...(opts.platform ? { platform: opts.platform } : {}),
      });
    }
    const repo = new DrizzleMediaRepository(opts.db);
    const row = await repo.findByIdScoped({
      organizationId: opts.organizationId,
      profileId: opts.profileId,
      id: item.mediaId,
    });
    if (!row) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Media not found.",
        rule: "media.unknown",
        ...(opts.platform ? { platform: opts.platform } : {}),
      });
    }
    return withUrlAlt(
      {
        kind: item.kind,
        url: buildPublicUrl({
          publicBaseUrl: getPublicBaseUrl(),
          s3Key: row.s3Key,
        }),
        mimeType: row.contentType,
      },
      item.altText,
    );
  }

  if (item.url) {
    return withUrlAlt({ kind: item.kind, url: item.url }, item.altText);
  }

  // bytesBase64 — not supportable for URL-consumers. Fail loudly with a
  // remediation pointing at /v1/media so the user knows the right path.
  throw new LetmepostError({
    code: "preflight_failed",
    status: 400,
    message:
      "Inline bytesBase64 isn't accepted on URL-consuming platforms (e.g. Pinterest).",
    rule: "media.bytes_inline_unsupported",
    ...(opts.platform ? { platform: opts.platform } : {}),
    remediation:
      "Upload via POST /v1/media first, then reference the returned id as { kind, mediaId }.",
  });
}

function withUrlAlt(
  base: Omit<ResolvedMediaUrl, "altText">,
  altText: string | undefined,
): ResolvedMediaUrl {
  return altText !== undefined ? { ...base, altText } : base;
}

async function loadFromMediaId(
  item: MediaInput,
  opts: LoadMediaOptions,
): Promise<LoadedMediaItem> {
  if (!item.mediaId) throw new Error("loadFromMediaId called without mediaId");
  if (!opts.db || !opts.organizationId || !opts.profileId) {
    // Loud fallback. Hitting this means a publisher is calling the resolver
    // without threading tenancy through — caller bug, not a user error.
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message:
        "Media resolver called without db/organizationId/profileId for a mediaId-shaped input.",
      ...(opts.platform ? { platform: opts.platform } : {}),
    });
  }

  const repo = new DrizzleMediaRepository(opts.db);
  const row = await repo.findByIdScoped({
    organizationId: opts.organizationId,
    profileId: opts.profileId,
    id: item.mediaId,
  });
  if (!row) {
    // 404 (not 403) so cross-tenant probing can't differentiate "exists but
    // not yours" from "doesn't exist".
    throw new LetmepostError({
      code: "not_found",
      status: 404,
      message: "Media not found.",
      rule: "media.unknown",
      ...(opts.platform ? { platform: opts.platform } : {}),
    });
  }

  const url = buildPublicUrl({
    publicBaseUrl: getPublicBaseUrl(),
    s3Key: row.s3Key,
  });
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new LetmepostError({
      code: "platform_unavailable",
      status: 503,
      message: `Failed to fetch media bytes from ${url}.`,
      ...(opts.platform ? { platform: opts.platform } : {}),
      remediation:
        "S3 may be transiently unavailable; retry, or contact support if persistent.",
    });
  }
  if (!res.ok) {
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message: `Media bytes unreachable (S3 returned ${res.status}).`,
      ...(opts.platform ? { platform: opts.platform } : {}),
    });
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);

  return withAlt(
    {
      kind: item.kind,
      mimeType: row.contentType,
      byteLength: bytes.byteLength,
      bytes,
    },
    item.altText,
  );
}
