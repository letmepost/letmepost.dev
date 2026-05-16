import type { PublishResult, MediaInput } from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";
import {
  resolveMediaToUrl,
  type MediaResolverContext,
  type ResolvedMediaUrl,
} from "../_shared/media.js";
import type { Publisher } from "../_shared/publisher.js";
import {
  InstagramClient,
  type InstagramContainerStatus,
  type InstagramCreateContainerInput,
} from "./client.js";
import {
  classifyInstagramPost,
  validateInstagramMedia,
  validateInstagramMediaShape,
  validateInstagramText,
} from "./preflight.js";

/**
 * Instagram Business publisher. Mirrors Threads's create-container →
 * poll-FINISHED → publish flow but with IG-specific status field names
 * (`status_code` not `status`) and IG-specific media type rules
 * (JPEG-only, REELS for video, CAROUSEL for 2-10 items).
 *
 * Uses the parent Page's access token — the credentials struct here
 * carries the IG user id + Page Access Token, both pinned at connect
 * time by the Meta provider's fan-out.
 */

export type InstagramCredentials = {
  /**
   * Either a Page Access Token (from FB-Login fan-out) or an IG user
   * token (from Instagram Login). The graphBase tells the publisher
   * which upstream host the token is valid against.
   */
  accessToken: string;
  /** IG Business user id — `platformAccountId` on the row. */
  igUserId: string;
  /**
   * Override the Graph API base. Defaults to `graph.facebook.com` for
   * Page-token rows. Set to `graph.instagram.com` for IG-Login rows.
   */
  graphBase?: string;
};

export type InstagramPublishInput = {
  text: string;
  media?: MediaInput[];
  mediaContext?: MediaResolverContext;
};

const POLL_INTERVAL_MS = 1_500;
const IMAGE_POLL_TIMEOUT_MS = 60_000;
const VIDEO_POLL_TIMEOUT_MS = 6 * 60_000;

const TERMINAL_STATUSES = new Set<InstagramContainerStatus>([
  "FINISHED",
  "ERROR",
  "EXPIRED",
  "PUBLISHED",
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilFinished(
  client: InstagramClient,
  containerId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const { status_code, status } = await client.getContainerStatus(
      containerId,
    );
    if (status_code === "FINISHED") return;
    if (TERMINAL_STATUSES.has(status_code)) {
      throw new LetmepostError({
        code: "platform_rejected",
        status: 400,
        message: `Instagram container ${containerId} ended in ${status_code}.`,
        rule:
          status_code === "EXPIRED"
            ? "instagram.container.expired"
            : "instagram.container.error",
        platform: "instagram",
        ...(status ? { platformResponse: { status } } : {}),
        remediation:
          status_code === "EXPIRED"
            ? "Instagram expires unpublished containers after 24 hours. Re-create and publish in one flow."
            : "Instagram rejected the container. Inspect platformResponse.status for the upstream reason.",
      });
    }
    if (Date.now() >= deadline) {
      throw new LetmepostError({
        code: "platform_unavailable",
        status: 504,
        message: `Instagram container ${containerId} did not finish within ${timeoutMs}ms.`,
        platform: "instagram",
        remediation:
          "Retry the publish; Instagram's video transcoding occasionally exceeds normal SLAs.",
      });
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function resolveAll(
  media: MediaInput[],
  ctx: MediaResolverContext | undefined,
): Promise<ResolvedMediaUrl[]> {
  return Promise.all(
    media.map((item) =>
      resolveMediaToUrl(item, {
        platform: "instagram",
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

function singleContainerInput(
  resolved: ResolvedMediaUrl,
  caption: string,
): InstagramCreateContainerInput {
  if (resolved.kind === "image") {
    const input: InstagramCreateContainerInput = {
      mediaType: "IMAGE",
      imageUrl: resolved.url,
    };
    if (caption.trim().length > 0) input.caption = caption;
    if (resolved.altText !== undefined) input.altText = resolved.altText;
    return input;
  }
  // Single-video posts use REELS (IG retired the legacy VIDEO product
  // surface in 2024; REELS is the canonical single-video container).
  const input: InstagramCreateContainerInput = {
    mediaType: "REELS",
    videoUrl: resolved.url,
  };
  if (caption.trim().length > 0) input.caption = caption;
  if (resolved.altText !== undefined) input.altText = resolved.altText;
  return input;
}

function carouselChildInput(
  resolved: ResolvedMediaUrl,
): InstagramCreateContainerInput {
  const input: InstagramCreateContainerInput = {
    mediaType: resolved.kind === "image" ? "IMAGE" : "VIDEO",
    isCarouselItem: true,
  };
  if (resolved.kind === "image") {
    input.imageUrl = resolved.url;
  } else {
    input.videoUrl = resolved.url;
  }
  if (resolved.altText !== undefined) input.altText = resolved.altText;
  return input;
}

function carouselTimeoutFor(items: ResolvedMediaUrl[]): number {
  return items.some((i) => i.kind === "video")
    ? VIDEO_POLL_TIMEOUT_MS
    : IMAGE_POLL_TIMEOUT_MS;
}

async function finalizePublish(
  client: InstagramClient,
  creationId: string,
): Promise<PublishResult> {
  const published = await client.publishContainer(creationId);
  const permalink = await client.getPermalink(published.id);
  const response: PublishResult = {
    id: published.id,
    platform: "instagram",
    createdAt: new Date().toISOString(),
  };
  if (permalink) response.uri = permalink;
  return response;
}

export const instagramPublisher: Publisher<
  InstagramCredentials,
  InstagramPublishInput
> = {
  async publish(creds, input): Promise<PublishResult> {
    const { text, media = [], mediaContext } = input;

    validateInstagramText(text, media.length);
    validateInstagramMediaShape(
      media.map((m) => {
        const item: { kind: "image" | "video"; altText?: string } = {
          kind: m.kind,
        };
        if (m.altText !== undefined) item.altText = m.altText;
        return item;
      }),
    );

    const resolved = await resolveAll(media, mediaContext);
    validateInstagramMedia(
      resolved.map((r) => {
        const item: {
          kind: "image" | "video";
          mimeType: string;
          altText?: string;
        } = {
          kind: r.kind,
          mimeType:
            r.mimeType ?? (r.kind === "image" ? "image/jpeg" : "video/mp4"),
        };
        if (r.altText !== undefined) item.altText = r.altText;
        return item;
      }),
    );

    const client = new InstagramClient(
      creds.accessToken,
      creds.igUserId,
      creds.graphBase,
    );
    const shape = classifyInstagramPost(resolved.map((r) => ({ kind: r.kind })));

    // ─── Single image / single video ─────────────────────────────────────
    if (shape.kind === "single-image" || shape.kind === "single-video") {
      const create = await client.createContainer(
        singleContainerInput(resolved[0]!, text),
      );
      const timeout =
        shape.kind === "single-video"
          ? VIDEO_POLL_TIMEOUT_MS
          : IMAGE_POLL_TIMEOUT_MS;
      await pollUntilFinished(client, create.id, timeout);
      return finalizePublish(client, create.id);
    }

    // ─── Carousel (2..10) ────────────────────────────────────────────────
    const children = await Promise.all(
      resolved.map((r) => client.createContainer(carouselChildInput(r))),
    );

    const childTimeout = carouselTimeoutFor(resolved);
    await Promise.all(
      children.map((c) => pollUntilFinished(client, c.id, childTimeout)),
    );

    const parent = await client.createContainer({
      mediaType: "CAROUSEL",
      children: children.map((c) => c.id),
      ...(text.trim().length > 0 ? { caption: text } : {}),
    });
    await pollUntilFinished(client, parent.id, IMAGE_POLL_TIMEOUT_MS);
    return finalizePublish(client, parent.id);
  },
};
