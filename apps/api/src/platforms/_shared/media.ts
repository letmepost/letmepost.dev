import type { MediaInput } from "@letmepost/schemas";
import type { DrizzleClient } from "../../db/index.js";
import { LetmepostError } from "../../errors.js";
import {
  buildPublicUrl,
  getPublicBaseUrl,
} from "../../media/s3.js";
import { DrizzleMediaRepository } from "../../repositories/media.js";
import { guardedFetch, isDisallowedUrlError } from "../../net/guarded-fetch.js";
import { fitImageToBytes } from "./downscale.js";
import { resolveMimeType, SNIFF_HEADER_BYTES } from "./mime.js";

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
  /**
   * Platform image ceiling. When set, an oversized image is re-encoded to fit
   * rather than rejected, so one upload can serve platforms whose limits
   * differ by 5x. No-op for video, animated GIFs, and images already under.
   */
  fitImageToBytes?: number;
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
    // `kind` alone can't tell png from jpeg from webp; sniff the bytes.
    const mimeType = resolveMimeType(
      bytes,
      item.kind === "image" ? "image/jpeg" : "video/mp4",
    );
    return withAlt(
      await applyFit({ kind: item.kind, mimeType, bytes }, opts),
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

  let res: Response;
  try {
    res = await guardedFetch(item.url);
  } catch (err) {
    if (isDisallowedUrlError(err)) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "The media URL is not allowed.",
        rule: "media.url.disallowed",
        ...(opts.platform ? { platform: opts.platform } : {}),
        remediation:
          "Provide a publicly reachable https URL, or inline the media via bytesBase64.",
      });
    }
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

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const contentType = res.headers.get("content-type");
  const declared = contentType
    ? contentType.split(";")[0]!.trim().toLowerCase()
    : item.kind === "image"
      ? "image/jpeg"
      : "video/mp4";
  // The origin's Content-Type is a hint, not the truth: object stores hand
  // back `application/octet-stream` for perfectly valid JPEGs.
  const mimeType = resolveMimeType(bytes, declared);

  return withAlt(
    await applyFit({ kind: item.kind, mimeType, bytes }, opts),
    item.altText,
  );
}

/** Shrink to the platform ceiling when the caller set one. */
async function applyFit(
  base: { kind: "image" | "video"; mimeType: string; bytes: Uint8Array },
  opts: LoadMediaOptions,
): Promise<Omit<LoadedMediaItem, "altText">> {
  if (!opts.fitImageToBytes || base.kind !== "image") {
    return { ...base, byteLength: base.bytes.byteLength };
  }
  const fitted = await fitImageToBytes(base.bytes, base.mimeType, opts.fitImageToBytes);
  return {
    kind: base.kind,
    mimeType: fitted.mimeType,
    bytes: fitted.bytes,
    byteLength: fitted.bytes.byteLength,
  };
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
    const url = buildPublicUrl({
      publicBaseUrl: getPublicBaseUrl(),
      s3Key: row.s3Key,
    });
    return withUrlAlt(
      {
        kind: item.kind,
        // URL-consuming platforms (Threads, Meta, Pinterest) preflight on this
        // value, so a row stored before uploads sniffed their own bytes would
        // still be rejected on mime. This path has no bytes in hand, so refine
        // only when the stored type is a placeholder.
        mimeType: await refineStoredMimeType(url, row.contentType),
        url,
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

/** Types that carry no information — what a client that omitted a part header got. */
const PLACEHOLDER_CONTENT_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

/**
 * Recover a real mime type for a `media` row stored with a placeholder, by
 * range-fetching just the signature bytes. Rows with a meaningful stored type
 * — every row written since uploads started sniffing — return immediately and
 * pay nothing. Failures fall back to the stored value rather than blocking a
 * publish on a diagnostic fetch.
 */
async function refineStoredMimeType(
  url: string,
  stored: string,
): Promise<string> {
  if (!PLACEHOLDER_CONTENT_TYPES.has(stored.trim().toLowerCase())) return stored;
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${SNIFF_HEADER_BYTES - 1}` },
    });
    if (!res.ok) return stored;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return resolveMimeType(bytes, stored);
  } catch {
    return stored;
  }
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
    await applyFit(
      // The row stores whatever the upload's part header declared.
      { kind: item.kind, mimeType: resolveMimeType(bytes, row.contentType), bytes },
      opts,
    ),
    item.altText,
  );
}
