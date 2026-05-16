import type { PublishResult, MediaInput } from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";
import {
  resolveMediaToUrl,
  type MediaResolverContext,
  type ResolvedMediaUrl,
} from "../_shared/media.js";
import type { Publisher } from "../_shared/publisher.js";
import {
  ThreadsClient,
  type ThreadsContainerStatus,
  type ThreadsCreateContainerInput,
} from "./client.js";
import {
  validateThreadsMedia,
  validateThreadsMediaShape,
  validateThreadsText,
} from "./preflight.js";

/**
 * Threads credentials passed to the publisher. Resolved from
 * `platform_accounts` by the dispatcher — the publisher itself never
 * touches the DB or env.
 *
 *   - `accessToken` = the long-lived 60-day token persisted at connect.
 *   - `userId`      = the Threads numeric user id used to scope the
 *                     `/{user-id}/threads` and `/{user-id}/threads_publish`
 *                     paths. Same value as platformAccountId.
 */
export type ThreadsCredentials = {
  accessToken: string;
  userId: string;
};

export type ThreadsPublishInput = {
  /** Caption / post body. Required for TEXT posts; optional for media posts. */
  text: string;
  media?: MediaInput[];
  /** Parent thread id when this post is a reply (Threads `reply_to_id`). */
  replyToId?: string;
  /** Required when any media item references a `mediaId`. */
  mediaContext?: MediaResolverContext;
};

/**
 * How long we wait for a media container to reach FINISHED before giving
 * up and surfacing a `platform_unavailable` to the caller. Threads's
 * recommendation is 1-2s for images, several seconds for videos. We use
 * 60s for images and a separate 6-minute ceiling for videos because
 * large MP4 transcoding genuinely takes that long.
 */
const POLL_INTERVAL_MS = 1_500;
const IMAGE_POLL_TIMEOUT_MS = 60_000;
const VIDEO_POLL_TIMEOUT_MS = 6 * 60_000;

const TERMINAL_STATUSES = new Set<ThreadsContainerStatus>([
  "FINISHED",
  "ERROR",
  "EXPIRED",
  "PUBLISHED",
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveAll(
  media: MediaInput[],
  ctx: MediaResolverContext | undefined,
): Promise<ResolvedMediaUrl[]> {
  return Promise.all(
    media.map((item) =>
      resolveMediaToUrl(item, {
        platform: "threads",
        ...(ctx
          ? {
              db: ctx.db,
              organizationId: ctx.organizationId,
              profileId: ctx.profileId,
            }
          : {}),
      }),
    ),
  );
}

/**
 * Poll a container until it reaches a terminal state or we hit the
 * timeout. ERROR/EXPIRED/PUBLISHED-on-status surface as
 * `platform_rejected` because Threads has actively decided not to keep
 * processing — it's not a transient network issue we can retry around.
 */
async function pollUntilFinished(
  client: ThreadsClient,
  containerId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const { status, error_message } = await client.getContainerStatus(
      containerId,
    );
    if (status === "FINISHED") return;
    if (TERMINAL_STATUSES.has(status)) {
      throw new LetmepostError({
        code: "platform_rejected",
        status: 400,
        message: `Threads container ${containerId} ended in ${status}.`,
        rule: status === "EXPIRED" ? "threads.container.expired" : "threads.container.error",
        platform: "threads",
        ...(error_message ? { platformResponse: { error_message } } : {}),
        remediation:
          status === "EXPIRED"
            ? "Threads expires unpublished containers after 24 hours. Re-create and publish in one flow."
            : "Threads rejected the container. Inspect platformResponse.error_message for the upstream reason.",
      });
    }
    if (Date.now() >= deadline) {
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 504,
        message: `Threads container ${containerId} did not finish within ${timeoutMs}ms.`,
        platform: "threads",
        remediation:
          "Retry the publish; Threads's video transcoding is occasionally slow but usually completes within a minute or two.",
      });
    }
    await delay(POLL_INTERVAL_MS);
  }
}

function containerInputFor(
  resolved: ResolvedMediaUrl,
  opts: { isCarouselItem?: boolean; replyToId?: string; text?: string } = {},
): ThreadsCreateContainerInput {
  const input: ThreadsCreateContainerInput = {
    mediaType: resolved.kind === "image" ? "IMAGE" : "VIDEO",
  };
  if (resolved.kind === "image") {
    input.imageUrl = resolved.url;
  } else {
    input.videoUrl = resolved.url;
  }
  if (resolved.altText !== undefined) input.altText = resolved.altText;
  if (opts.isCarouselItem) input.isCarouselItem = true;
  if (opts.text !== undefined) input.text = opts.text;
  if (opts.replyToId !== undefined) input.replyToId = opts.replyToId;
  return input;
}

function containerTimeoutFor(items: ResolvedMediaUrl[]): number {
  return items.some((i) => i.kind === "video")
    ? VIDEO_POLL_TIMEOUT_MS
    : IMAGE_POLL_TIMEOUT_MS;
}

export const threadsPublisher: Publisher<
  ThreadsCredentials,
  ThreadsPublishInput
> = {
  async publish(creds, input): Promise<PublishResult> {
    const { text, media = [], replyToId, mediaContext } = input;

    // Cheap shape checks first — count + alt-text length. Bails out
    // before any URL resolution / HEAD probes if the request is shaped
    // wrong (e.g. 25 images).
    validateThreadsText(text, media.length);
    validateThreadsMediaShape(
      media.map((m) => {
        const item: { kind: "image" | "video"; altText?: string } = {
          kind: m.kind,
        };
        if (m.altText !== undefined) item.altText = m.altText;
        return item;
      }),
    );

    const client = new ThreadsClient(creds.accessToken);

    // ─── TEXT-only ───────────────────────────────────────────────────────
    if (media.length === 0) {
      const create = await client.createContainer(creds.userId, {
        mediaType: "TEXT",
        text,
        ...(replyToId !== undefined ? { replyToId } : {}),
      });
      // Even text containers go through the same status surface. Threads
      // returns FINISHED almost immediately for TEXT but we still poll —
      // keeps the publish path uniform and catches the rare case where a
      // container is rejected post-create (e.g. policy filter).
      await pollUntilFinished(client, create.id, IMAGE_POLL_TIMEOUT_MS);
      return finalizePublish(client, creds, create.id, text);
    }

    // ─── Resolve URLs + run mime/size preflight ──────────────────────────
    const resolved = await resolveAll(media, mediaContext);
    validateThreadsMedia(
      resolved.map((r) => {
        const item: {
          kind: "image" | "video";
          mimeType: string;
          altText?: string;
        } = {
          kind: r.kind,
          // mimeType is unknown for raw URL inputs; fall back to a
          // permissive default so the mime preflight is a no-op for that
          // path. The mediaId path always carries a real mimeType.
          mimeType: r.mimeType ?? (r.kind === "image" ? "image/jpeg" : "video/mp4"),
        };
        if (r.altText !== undefined) item.altText = r.altText;
        return item;
      }),
    );

    // ─── Single IMAGE or VIDEO ───────────────────────────────────────────
    if (resolved.length === 1) {
      const only = resolved[0]!;
      const create = await client.createContainer(
        creds.userId,
        containerInputFor(only, {
          text,
          ...(replyToId !== undefined ? { replyToId } : {}),
        }),
      );
      await pollUntilFinished(client, create.id, containerTimeoutFor([only]));
      return finalizePublish(client, creds, create.id, text);
    }

    // ─── CAROUSEL (2..20) ────────────────────────────────────────────────
    // Threads requires every child container to reach FINISHED before the
    // parent CAROUSEL container can be created. Create all children first,
    // poll all in parallel, then build the parent.
    const children = await Promise.all(
      resolved.map((item) =>
        client.createContainer(creds.userId, containerInputFor(item, {
          isCarouselItem: true,
        })),
      ),
    );

    const childTimeout = containerTimeoutFor(resolved);
    await Promise.all(
      children.map((c) => pollUntilFinished(client, c.id, childTimeout)),
    );

    const parent = await client.createContainer(creds.userId, {
      mediaType: "CAROUSEL",
      children: children.map((c) => c.id),
      text,
      ...(replyToId !== undefined ? { replyToId } : {}),
    });
    // The parent CAROUSEL container also has a status field — usually flips
    // to FINISHED very fast since the children are already processed, but
    // we poll anyway for the same reasons as TEXT.
    await pollUntilFinished(client, parent.id, IMAGE_POLL_TIMEOUT_MS);
    return finalizePublish(client, creds, parent.id, text);
  },
};

/**
 * Final publish step shared by all media types. Threads's publish
 * response only carries the post id, so we follow up with `getPost` to
 * fetch the canonical permalink — best-effort; if it 404s we still
 * return a successful publish (the post is live).
 */
async function finalizePublish(
  client: ThreadsClient,
  creds: ThreadsCredentials,
  creationId: string,
  text: string,
): Promise<PublishResult> {
  const published = await client.publishContainer(creds.userId, creationId);

  // Permalink fetch is best-effort. The dashboard's Post Log surfaces
  // platformUri when present, and falls back to the post id otherwise.
  const detail = await client.getPost(published.id);
  const response: PublishResult = {
    id: published.id,
    platform: "threads",
    createdAt: new Date().toISOString(),
  };
  if (detail?.permalink) response.uri = detail.permalink;
  // `text` parameter retained for parity with finalize patterns on other
  // platforms; Threads doesn't echo text on the publish response.
  void text;
  return response;
}
