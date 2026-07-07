import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import kleur from "kleur";
import {
  apiFetch,
  failWithApiError,
  requireAuth,
  CliError,
} from "../client.js";
import { resolveProfileId } from "../config.js";
import { renderTargetFailure, renderTargetSuccess } from "../format.js";

const VALID_PLATFORMS = new Set([
  "bluesky",
  "facebook",
  "instagram",
  "linkedin",
  "pinterest",
  "threads",
  "twitter",
]);

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
};

export type PostOptions = {
  to: string;
  media?: string;
  firstComment?: string;
  schedule?: string;
  profile?: string;
};

type MediaInput = {
  kind: "image" | "video";
  mediaId?: string;
  url?: string;
  altText?: string;
};

type TargetResult = {
  accountId: string;
  platform: string;
  postId?: string;
  status: string;
  uri?: string;
  error?: { code: string; message: string; rule?: string; remediation?: string };
};

type CreatePostResponse = {
  id: string;
  status: "queued" | "published" | "partial_failed" | "failed";
  scheduledAt?: string;
  results: TargetResult[];
};

/**
 * `lmp post "<text>" --to=…` — publish (or schedule) to one or more
 * platforms. Splits `--to` and `--media` on commas; uploads any local
 * files via `POST /v1/media` first, then sends the batch publish.
 *
 * Exit codes:
 *   0  every target succeeded (or batch was queued)
 *   1  network / auth / shape error
 *   2  the publish completed but at least one target failed
 */
export async function runPost(text: string, options: PostOptions): Promise<void> {
  if (!text || text.trim().length === 0) {
    throw new CliError("Post text is required.");
  }

  const platforms = options.to
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (platforms.length === 0) {
    throw new CliError("Pass --to=<platform>[,<platform>…].");
  }
  for (const p of platforms) {
    if (!VALID_PLATFORMS.has(p)) {
      throw new CliError(
        `Unknown platform "${p}". Valid platforms: ${[...VALID_PLATFORMS].join(", ")}.`,
      );
    }
  }

  const mediaPaths = options.media
    ? options.media
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Resolve the profile scope once, up front, so the media uploads and the
  // publish land in the SAME profile. `POST /v1/media` scopes an org-wide key's
  // upload to the org "default" profile unless `?profileId=` is passed; if the
  // publish then targets a non-default profile the mediaId won't resolve there
  // (404). Threading the same id through both calls keeps them aligned.
  const profileId = resolveProfileId(options.profile);

  // Upload local media up front so the failure surface is "file not found"
  // before we touch the publish endpoint. Each upload reuses the same auth.
  const media: MediaInput[] = [];
  for (const path of mediaPaths) {
    media.push(await uploadMedia(path, profileId));
  }

  const body: Record<string, unknown> = {
    text,
    targets: platforms.map((platform) => ({ platform })),
  };
  if (media.length > 0) body["media"] = media;
  if (options.firstComment) body["firstComment"] = { text: options.firstComment };
  if (options.schedule) body["scheduledAt"] = options.schedule;
  // `profileId` is a sibling field on the create-post body (not a query param).
  // The API support for it ships in parallel; if the route doesn't know the
  // field yet the request fails with `validation_failed rule: unknown_field`,
  // which the structured error renderer surfaces cleanly.
  if (profileId) body["profileId"] = profileId;

  const result = await apiFetch<CreatePostResponse>("/v1/posts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!result.ok) failWithApiError(result);

  renderBatchResult(result.body);
}

async function uploadMedia(
  path: string,
  profileId: string | null,
): Promise<MediaInput> {
  const absolute = resolve(path);
  let bytes: Buffer;
  try {
    await stat(absolute);
    bytes = await readFile(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CliError(`Media file not found: ${path}`);
    }
    throw new CliError(
      `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const ext = extname(absolute).toLowerCase();
  const kind: "image" | "video" = VIDEO_EXTS.has(ext)
    ? "video"
    : IMAGE_EXTS.has(ext)
      ? "image"
      : "image"; // default to image; the API will reject misclassified bytes.
  const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";

  // Build the multipart body by hand — avoids pulling in form-data just for one
  // request. Node's built-in FormData + Blob are good enough on >=18.
  const auth = requireAuth();
  const form = new FormData();
  // Convert Buffer to Uint8Array view (avoids Blob constructor type drift on
  // some @types/node versions where Buffer isn't assignable to BlobPart).
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blob = new Blob([view], { type: contentType });
  form.append("file", blob, basename(absolute));

  // Scope the upload to the publish target's profile. The media route reads
  // `?profileId=` (query param), mirroring GET /v1/media and the accounts
  // routes; without it an org-wide key drops the upload into the default
  // profile and a non-default publish target 404s on the mediaId.
  const uploadUrl = profileId
    ? `${auth.baseUrl}/v1/media?${new URLSearchParams({ profileId }).toString()}`
    : `${auth.baseUrl}/v1/media`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Idempotency-Key": globalThis.crypto.randomUUID(),
    },
    body: form,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body — fall through.
  }
  if (!res.ok) {
    failWithApiError({ status: res.status, body: parsed });
  }
  const body = parsed as { id?: string };
  if (!body.id) {
    throw new CliError(
      `Media upload for ${path} did not return an id (HTTP ${res.status}).`,
    );
  }
  return { kind, mediaId: body.id };
}

/** Pretty-print the batch envelope. Sets exit code 2 on any failure. */
function renderBatchResult(body: CreatePostResponse): void {
  for (const r of body.results) {
    if (r.status === "published") {
      process.stdout.write(`${renderTargetSuccess(r.platform, r.uri)}\n`);
    } else if (r.status === "queued") {
      process.stdout.write(
        `${kleur.cyan("◷")} queued for ${r.platform}${r.postId ? ` (post ${r.postId})` : ""}\n`,
      );
    } else {
      // rejected / failed / publishing (transient) — show the error block.
      process.stderr.write(
        `${renderTargetFailure(r.platform, r.error ?? { code: r.status })}\n`,
      );
    }
  }

  const summary = `batch ${body.id} (${body.status})`;
  if (body.status === "published" || body.status === "queued") {
    process.stdout.write(`${kleur.gray(summary)}\n`);
    return;
  }
  process.stdout.write(`${kleur.gray(summary)}\n`);
  // partial_failed or failed → non-zero exit so shell pipelines can branch.
  throw new CliError("", 2);
}
