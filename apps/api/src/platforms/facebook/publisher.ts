import type { PublishResult, MediaInput } from "@letmepost/schemas";
import {
  resolveMediaToUrl,
  type MediaResolverContext,
  type ResolvedMediaUrl,
} from "../_shared/media.js";
import type { Publisher } from "../_shared/publisher.js";
import { FacebookClient } from "./client.js";
import {
  validateFacebookMedia,
  validateFacebookMediaShape,
  validateFacebookText,
} from "./preflight.js";

/**
 * Facebook Pages publisher. Routes the request to one of three Graph
 * endpoints based on media:
 *
 *   - 0 media           → POST /{page}/feed (text-only or link share)
 *   - 1 image           → POST /{page}/photos
 *   - N images (N≥2)    → POST /{page}/photos (published=false) × N,
 *                          then POST /{page}/feed with attached_media
 *   - 1 video           → POST /{page}/videos
 *
 * Page Access Token (NON-EXPIRING) is the only auth — derived at connect
 * time via /me/accounts and persisted on each `facebook` row.
 */

export type FacebookCredentials = {
  /** Page Access Token (not the User Access Token). */
  accessToken: string;
  /** FB Page id — used as the path segment on /{page}/feed etc. */
  pageId: string;
};

export type FacebookPublishInput = {
  text: string;
  media?: MediaInput[];
  /** Optional link share — only honored on text-only posts. */
  link?: string;
  mediaContext?: MediaResolverContext;
};

async function resolveAll(
  media: MediaInput[],
  ctx: MediaResolverContext | undefined,
): Promise<ResolvedMediaUrl[]> {
  return Promise.all(
    media.map((item) =>
      resolveMediaToUrl(item, {
        platform: "facebook",
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

function permalinkFor(pageId: string, postId: string): string {
  // FB post ids come back as "<page-numeric-id>_<post-numeric-id>". The
  // dashboard wants a clickable URL; the canonical form is /{pageId}/posts/{postId}.
  // Dropping the "{page-id}_" prefix when present keeps the URL clean.
  const postOnly = postId.includes("_") ? postId.split("_")[1] : postId;
  return `https://www.facebook.com/${pageId}/posts/${postOnly}`;
}

export const facebookPublisher: Publisher<
  FacebookCredentials,
  FacebookPublishInput
> = {
  async publish(creds, input): Promise<PublishResult> {
    const { text, media = [], link, mediaContext } = input;

    validateFacebookText(text, media.length);
    validateFacebookMediaShape(media.map((m) => ({ kind: m.kind })));

    const client = new FacebookClient(creds.accessToken, creds.pageId);

    // ─── 0 media: feed-only post ─────────────────────────────────────────
    if (media.length === 0) {
      const post = await client.createFeedPost({
        message: text,
        ...(link !== undefined ? { link } : {}),
      });
      return {
        id: post.id,
        platform: "facebook",
        uri: permalinkFor(creds.pageId, post.id),
        createdAt: new Date().toISOString(),
      };
    }

    const resolved = await resolveAll(media, mediaContext);
    validateFacebookMedia(
      resolved.map((r) => ({
        kind: r.kind,
        mimeType: r.mimeType ?? (r.kind === "image" ? "image/jpeg" : "video/mp4"),
      })),
    );

    // ─── single video ────────────────────────────────────────────────────
    if (resolved.length === 1 && resolved[0]!.kind === "video") {
      const v = resolved[0]!;
      const result = await client.uploadVideo({
        fileUrl: v.url,
        description: text,
      });
      return {
        id: result.id,
        platform: "facebook",
        uri: `https://www.facebook.com/${creds.pageId}/videos/${result.id}`,
        createdAt: new Date().toISOString(),
      };
    }

    // ─── single image ────────────────────────────────────────────────────
    if (resolved.length === 1) {
      const i = resolved[0]!;
      const photo = await client.uploadPhoto({
        url: i.url,
        caption: text,
      });
      // Single-photo posts return both id (photo id) and post_id (the
      // resulting wall post). Prefer post_id for the platformUri.
      const postId = photo.post_id ?? photo.id;
      return {
        id: postId,
        platform: "facebook",
        uri: permalinkFor(creds.pageId, postId),
        createdAt: new Date().toISOString(),
      };
    }

    // ─── multi-image: stage unpublished photos, then a feed post ─────────
    const stagedIds = await Promise.all(
      resolved.map((i) =>
        client
          .uploadPhoto({ url: i.url, published: false })
          .then((p) => p.id),
      ),
    );
    const post = await client.createFeedPost({
      message: text,
      attachedMedia: stagedIds.map((id) => ({ media_fbid: id })),
    });
    return {
      id: post.id,
      platform: "facebook",
      uri: permalinkFor(creds.pageId, post.id),
      createdAt: new Date().toISOString(),
    };
  },
};
