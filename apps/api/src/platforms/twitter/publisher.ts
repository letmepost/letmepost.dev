import type { PublishResult, MediaInput } from "@letmepost/schemas";
import {
  loadMediaItem as sharedLoadMediaItem,
  type MediaResolverContext,
} from "../_shared/media.js";
import type { Publisher } from "../_shared/publisher.js";
import { TwitterClient } from "./client.js";
import {
  validateTwitterMedia,
  validateTwitterMediaShape,
  validateTwitterText,
  type TwitterResolvedMediaItem,
} from "./preflight.js";

export type TwitterCredentials = {
  /** OAuth 2.0 access token. */
  accessToken: string;
  /** Upstream user id (x.com `id`), surfaced in the response. */
  userId?: string;
  /** Override the API base — tests point at MSW. */
  apiBase?: string;
  /** Override the upload base — tests point at MSW. */
  uploadBase?: string;
};

export type TwitterPublishInput = {
  text: string;
  /** Up to 4 images, OR a single video, OR a single GIF. */
  media?: MediaInput[];
  /** Required only if any media item references a `mediaId`. */
  mediaContext?: MediaResolverContext;
  /** Tweet id this tweet replies under (for reply chains / threads). */
  replyToTweetId?: string;
  /** Tweet id this tweet quotes. Mutually exclusive with replyToTweetId. */
  quoteTweetId?: string;
};

function loadMediaItem(
  item: MediaInput,
  ctx: MediaResolverContext | undefined,
) {
  return sharedLoadMediaItem(item, {
    platform: "twitter",
    reachableRule: "twitter.media.reachable",
    ...(ctx
      ? {
          db: ctx.db,
          organizationId: ctx.organizationId,
          profileId: ctx.profileId,
        }
      : {}),
  });
}

export const twitterPublisher: Publisher<
  TwitterCredentials,
  TwitterPublishInput
> = {
  async publish(creds, input): Promise<PublishResult> {
    const { text, media = [], mediaContext, replyToTweetId, quoteTweetId } =
      input;

    validateTwitterText(text);

    // Cheap shape checks first (count, image/video exclusivity, alt-text
    // length). Bails out before any URL fetch when the request shape is
    // wrong (e.g. 5 images, image+video mix).
    validateTwitterMediaShape(
      media.map((m) => {
        const item: { kind: "image" | "video"; altText?: string } = {
          kind: m.kind,
        };
        if (m.altText !== undefined) item.altText = m.altText;
        return item;
      }),
    );

    const loaded = await Promise.all(
      media.map((item) => loadMediaItem(item, mediaContext)),
    );
    validateTwitterMedia(
      loaded.map((l): TwitterResolvedMediaItem => {
        const item: TwitterResolvedMediaItem = {
          kind: l.kind,
          mimeType: l.mimeType,
          byteLength: l.byteLength,
        };
        if (l.altText !== undefined) item.altText = l.altText;
        return item;
      }),
    );

    const client = new TwitterClient(
      creds.accessToken,
      creds.apiBase,
      creds.uploadBase,
    );

    // Upload media in parallel, then attach alt text in parallel after.
    // Alt-text writes are best-effort — they go through the v1.1 metadata
    // endpoint, which is on a separate deprecation track from /2/tweets;
    // a metadata failure should not fail the publish.
    const uploaded = await Promise.all(
      loaded.map(async (item) => ({
        item,
        mediaId: await client.uploadMedia(item.bytes, item.mimeType),
      })),
    );
    await Promise.all(
      uploaded.map(({ item, mediaId }) =>
        item.altText !== undefined && item.altText.length > 0
          ? client
              .setMediaAltText(mediaId, item.altText)
              .catch(() => {
                // Swallow: the tweet still goes out without alt text.
                // Worth logging but not surfacing to the caller.
              })
          : Promise.resolve(),
      ),
    );
    const mediaIds = uploaded.map((u) => u.mediaId);

    const createArgs: Parameters<TwitterClient["createTweet"]>[0] = { text };
    if (mediaIds.length > 0) createArgs.mediaIds = mediaIds;
    if (replyToTweetId !== undefined) createArgs.replyToTweetId = replyToTweetId;
    if (quoteTweetId !== undefined) createArgs.quoteTweetId = quoteTweetId;
    const tweet = await client.createTweet(createArgs);

    const response: PublishResult = {
      id: tweet.id,
      platform: "twitter",
      uri: creds.userId
        ? `https://twitter.com/${creds.userId}/status/${tweet.id}`
        : `https://twitter.com/i/web/status/${tweet.id}`,
      createdAt: new Date().toISOString(),
    };
    return response;
  },
};
