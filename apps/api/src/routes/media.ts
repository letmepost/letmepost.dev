import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { Upload } from "@aws-sdk/lib-storage";
import Busboy from "busboy";
import { Hono } from "hono";
import type { CreateMediaResponse } from "@letmepost/schemas";
import { generateMediaId } from "../media/ids.js";
import {
  buildPublicUrl,
  buildS3Key,
  extForContentType,
  getBucketName,
  getEnvPrefix,
  getPublicBaseUrl,
  getS3Client,
} from "../media/s3.js";
import { LetmepostError } from "../errors.js";
import { apiKeyOrSession } from "../middleware/api-key-or-session.js";
import {
  resolveMimeType,
  SNIFF_HEADER_BYTES,
} from "../platforms/_shared/mime.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { DrizzleMediaRepository } from "../repositories/media.js";
import { DrizzleProfilesRepository } from "../repositories/profiles.js";

export const media = new Hono();

/** 200 MB ceiling for v1. YouTube long-form needs more, but the worker that
 *  actually uploads to YouTube is the place to bump this — keep the public
 *  surface conservative until we have telemetry on real upload sizes. */
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * `POST /v1/media`
 *
 * Multipart upload. The single `file` part is streamed straight to S3 via
 * `@aws-sdk/lib-storage`'s `Upload` (which handles multipart S3 internally
 * for files >5 MB). sha256 + size are computed by piping the part stream
 * through a passthrough hasher, so the row's metadata is always honest.
 *
 * On success the response carries the public URL — which is just
 * `${MEDIA_PUBLIC_BASE_URL}/${s3Key}`. Callers store the `id` and reference
 * it from post bodies as `media: [{ kind: "image", mediaId: "med_..." }]`.
 *
 * The body is intentionally consumed as a stream — `c.req.parseBody()` would
 * buffer the whole upload in memory, which defeats the YouTube long-form
 * use case.
 */
media.post("/", apiKeyOrSession(), rateLimit(), async (c) => {
  const { organizationId, profileId: keyProfileId } = c.var.apiKey;

  const requestedProfileId = c.req.query("profileId");
  const profileId = await resolveProfileId(
    c.var.db,
    organizationId,
    keyProfileId,
    requestedProfileId ?? null,
  );

  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message:
        "POST /v1/media requires Content-Type: multipart/form-data with a `file` part.",
      rule: "media.content_type",
      remediation:
        "Use a multipart upload (e.g. `curl -F file=@path/to/image.jpg`).",
    });
  }

  if (!c.req.raw.body) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: "Request body is empty.",
      rule: "media.empty_body",
    });
  }

  const upload = await streamPartToS3({
    organizationId,
    profileId,
    contentType,
    body: Readable.fromWeb(c.req.raw.body as never),
  });

  const repo = new DrizzleMediaRepository(c.var.db);
  const row = await repo.create({
    id: upload.mediaId,
    organizationId,
    profileId,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    sha256: upload.sha256,
    s3Key: upload.s3Key,
  });

  const body: CreateMediaResponse = {
    id: row.id,
    url: upload.publicUrl,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
  };
  return c.json(body, 201);
});

/**
 * `GET /v1/media`
 *
 * List uploaded media, scoped to the api-key's org and (when set) profile.
 * Org-wide keys can pass `?profileId=…` to narrow; profile-scoped keys are
 * pinned to their profile and ignore the query param. Cursor-paginated
 * (keyset on createdAt desc); responses include `nextCursor` when more
 * pages exist.
 *
 * Accepts either Bearer or session — the dashboard's media management
 * page reads through this with the cookie session.
 */
media.get("/", apiKeyOrSession(), rateLimit(), async (c) => {
  const { organizationId, profileId: keyProfileId } = c.var.apiKey;
  const requestedProfileId = c.req.query("profileId");
  const limitParam = c.req.query("limit");
  const cursor = c.req.query("cursor");

  // Resolution mirrors the POST path:
  //   - profile-scoped key + ?profileId mismatch → 404 (no leak)
  //   - profile-scoped key                        → use the key's profileId
  //   - org-wide key + ?profileId                 → use the request's
  //   - org-wide key (no query)                   → list across all profiles
  let effectiveProfileId: string | undefined;
  if (keyProfileId) {
    if (requestedProfileId && requestedProfileId !== keyProfileId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Profile not found.",
        rule: "api_key.profile_scope",
      });
    }
    effectiveProfileId = keyProfileId;
  } else if (requestedProfileId) {
    effectiveProfileId = requestedProfileId;
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: "limit must be a positive integer.",
      rule: "limit",
    });
  }

  const repo = new DrizzleMediaRepository(c.var.db);
  const filters: { organizationId: string; profileId?: string } = {
    organizationId,
  };
  if (effectiveProfileId) filters.profileId = effectiveProfileId;
  const opts: { limit?: number; cursor?: string } = {};
  if (limit !== undefined) opts.limit = limit;
  if (cursor) opts.cursor = cursor;
  const result = await repo.list(filters, opts);

  const baseUrl = (await import("../media/s3.js")).getPublicBaseUrl();
  return c.json({
    data: result.data.map((row) => ({
      id: row.id,
      url: `${baseUrl}/${row.s3Key}`,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      profileId: row.profileId,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: result.nextCursor,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Internals
 * ───────────────────────────────────────────────────────────────────────── */

type UploadResult = {
  mediaId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  s3Key: string;
  publicUrl: string;
};

async function streamPartToS3(args: {
  organizationId: string;
  profileId: string;
  contentType: string;
  body: Readable;
}): Promise<UploadResult> {
  const busboy = Busboy({
    headers: { "content-type": args.contentType },
    limits: { files: 1, fileSize: MAX_BYTES },
  });

  return new Promise<UploadResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let fileSeen = false;
    let truncated = false;

    busboy.on("file", (fieldname, fileStream, info) => {
      if (fieldname !== "file") {
        // Drain, ignore.
        fileStream.resume();
        return;
      }
      if (fileSeen) {
        fileStream.resume();
        settle(() =>
          reject(
            new LetmepostError({
              code: "validation_failed",
              status: 400,
              message:
                "POST /v1/media accepts exactly one `file` part per request.",
              rule: "media.single_file",
            }),
          ),
        );
        return;
      }
      fileSeen = true;

      const declaredContentType =
        info.mimeType?.toLowerCase() || "application/octet-stream";

      const mediaId = generateMediaId();
      const hash = createHash("sha256");
      let sizeBytes = 0;
      const passthrough = new PassThrough();

      // The S3 key's extension and the stored Content-Type both depend on the
      // real format, so hold the upload open until enough leading bytes have
      // arrived to sniff. Clients that omit the part's Content-Type would
      // otherwise pin the row to `application/octet-stream`, and every later
      // publish referencing that mediaId fails mime preflight on a valid file.
      let contentType = declaredContentType;
      let s3Key = "";
      let started = false;
      // Busboy emits whatever the socket delivered, so the first chunk is not
      // guaranteed to reach SNIFF_HEADER_BYTES. Accumulate until it does.
      let header: Buffer = Buffer.alloc(0);

      const beginUpload = (head: Buffer | null): void => {
        if (started) return;
        started = true;

        contentType = head
          ? resolveMimeType(head, declaredContentType)
          : declaredContentType;
        s3Key = buildS3Key({
          envPrefix: getEnvPrefix(),
          organizationId: args.organizationId,
          mediaId,
          ext: extForContentType(contentType),
        });

        const upload = new Upload({
          client: getS3Client(),
          params: {
            Bucket: getBucketName(),
            Key: s3Key,
            Body: passthrough,
            ContentType: contentType,
            /** Pinterest et al. occasionally probe with HEAD/GET; an inline
             *  disposition keeps preview-style fetchers happy. */
            ContentDisposition: "inline",
          },
        });

        upload
          .done()
          .then(() => {
            if (truncated) {
              settle(() =>
                reject(
                  new LetmepostError({
                    code: "validation_failed",
                    status: 413,
                    message: `Media file exceeds the ${MAX_BYTES} byte limit.`,
                    rule: "media.size_max",
                    remediation:
                      "Compress the asset, or open an issue if you need a higher limit for a specific platform.",
                  }),
                ),
              );
              return;
            }
            settle(() =>
              resolve({
                mediaId,
                contentType,
                sizeBytes,
                sha256: hash.digest("hex"),
                s3Key,
                publicUrl: buildPublicUrl({
                  publicBaseUrl: getPublicBaseUrl(),
                  s3Key,
                }),
              }),
            );
          })
          .catch((err: unknown) => {
            settle(() =>
              reject(
                new LetmepostError({
                  code: "internal_error",
                  status: 500,
                  message:
                    err instanceof Error
                      ? `S3 upload failed: ${err.message}`
                      : "S3 upload failed.",
                  platform: "s3",
                }),
              ),
            );
          });
      };

      // Registered before `.pipe()` so this runs first for each chunk; the
      // passthrough buffers the few bytes we wait on.
      fileStream.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        sizeBytes += chunk.length;
        if (started) return;
        header =
          header.length === 0 ? chunk : Buffer.concat([header, chunk]);
        if (header.length >= SNIFF_HEADER_BYTES) beginUpload(header);
      });
      // Stream ended before we had a full header (short or zero-byte file):
      // sniff what we got, so the path resolves instead of hanging.
      fileStream.on("end", () => {
        beginUpload(header.length > 0 ? header : null);
      });
      fileStream.on("limit", () => {
        truncated = true;
      });
      fileStream.pipe(passthrough);
    });

    busboy.on("error", (err: unknown) => {
      settle(() =>
        reject(
          new LetmepostError({
            code: "validation_failed",
            status: 400,
            message:
              err instanceof Error
                ? `Multipart parse failed: ${err.message}`
                : "Multipart parse failed.",
            rule: "media.parse_failed",
          }),
        ),
      );
    });

    busboy.on("finish", () => {
      if (!fileSeen) {
        settle(() =>
          reject(
            new LetmepostError({
              code: "validation_failed",
              status: 400,
              message: "POST /v1/media requires a `file` part.",
              rule: "media.missing_file",
            }),
          ),
        );
      }
    });

    args.body.pipe(busboy);
  });
}

/**
 * Mirrors the resolution rule used by `/v1/accounts/connect`:
 *   - profile-scoped key → must match (or omit) `?profileId`
 *   - org-wide key       → uses `?profileId` if supplied, else org's "default"
 *
 * Cross-profile access surfaces as 404, never 403, to avoid leaking
 * profile-existence to a key that shouldn't see it.
 */
async function resolveProfileId(
  db: import("../db/index.js").DrizzleClient,
  organizationId: string,
  keyProfileId: string | null,
  requestedProfileId: string | null,
): Promise<string> {
  if (keyProfileId) {
    if (requestedProfileId && requestedProfileId !== keyProfileId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Profile not found.",
        rule: "api_key.profile_scope",
      });
    }
    return keyProfileId;
  }

  const profilesRepo = new DrizzleProfilesRepository(db);

  if (requestedProfileId) {
    const profile = await profilesRepo.findById(requestedProfileId);
    if (!profile || profile.organizationId !== organizationId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Profile not found.",
        rule: "profile.unknown",
      });
    }
    return profile.id;
  }

  const def = await profilesRepo.findByOrgAndSlug(organizationId, "default");
  if (def) return def.id;

  throw new LetmepostError({
    code: "internal_error",
    status: 500,
    message: "Default profile missing for organization.",
  });
}
