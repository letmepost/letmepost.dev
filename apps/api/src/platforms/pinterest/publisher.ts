import type { PublishResult } from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";
import {
  loadMediaItem,
  resolveMediaToUrl,
  type MediaResolverContext,
} from "../_shared/media.js";
import type { Publisher } from "../_shared/publisher.js";
import { PinterestClient } from "./client.js";
import {
  assertPinterestCoverImageReachable,
  assertPinterestUrlsReachable,
  validatePinterestInput,
  validatePinterestVideoBytes,
  type PinterestPublishInput,
} from "./preflight.js";

/**
 * Credentials the Pinterest publisher needs. Token comes from the
 * platform_accounts.token column (decrypted at the repository boundary).
 */
export type PinterestCredentials = {
  /** Pinterest access token (OAuth 2.0 bearer). */
  accessToken: string;
  /** Override the API base — tests point at MSW. */
  apiBase?: string;
};

export const pinterestPublisher: Publisher<
  PinterestCredentials,
  PinterestPublishInput & { mediaContext?: MediaResolverContext }
> = {
  async publish(creds, input): Promise<PublishResult> {
    // Pure preflight (board / media presence / kind / cover-required for
    // video) before any network round-trip.
    validatePinterestInput(input);

    const mediaItem = input.media[0]!;
    const client = new PinterestClient(creds.accessToken, creds.apiBase);

    const createArgs: Parameters<PinterestClient["createPin"]>[0] = {
      boardId: input.boardId,
      // Will be overwritten below — image path falls back to the resolved
      // URL, video path falls back to the cover image URL.
      destinationUrl: input.destinationUrl ?? "",
    };
    if (input.title !== undefined) createArgs.title = input.title;
    if (input.text !== undefined) createArgs.description = input.text;

    if (mediaItem.kind === "video") {
      // ─── Video pin path ───────────────────────────────────────────
      // Pinterest's video upload is a four-step dance:
      //   1. Resolve bytes (mediaId, url, or bytesBase64).
      //   2. POST /v5/media to register a slot. Returns a presigned S3
      //      endpoint + form-field bag.
      //   3. Multipart-upload bytes to S3.
      //   4. Poll GET /v5/media/{id} until status=succeeded.
      // Then createPin with `media_source: { source_type: "video_id" }`.
      const loaded = await loadMediaItem(mediaItem, {
        platform: "pinterest",
        reachableRule: "pinterest.video.reachable",
        ...(input.mediaContext
          ? {
              db: input.mediaContext.db,
              organizationId: input.mediaContext.organizationId,
              profileId: input.mediaContext.profileId,
            }
          : {}),
      });

      validatePinterestVideoBytes({
        mimeType: loaded.mimeType,
        byteLength: loaded.byteLength,
      });

      // Cover image URL is preflight-required for video pins; the
      // validator above already failed loudly if it's missing.
      await assertPinterestCoverImageReachable(input.coverImageUrl!);
      if (input.destinationUrl) {
        // Don't probe the cover image AND the destination twice — assert
        // destination separately to give a precise rule on failure.
        await assertPinterestUrlsReachable({
          imageUrl: input.coverImageUrl!,
          destinationUrl: input.destinationUrl,
        });
      }

      const slot = await client.registerMedia();
      await client.uploadVideoBytes({
        uploadUrl: slot.upload_url,
        uploadParameters: slot.upload_parameters,
        bytes: loaded.bytes,
        mimeType: loaded.mimeType,
      });
      await client.waitForMediaReady(slot.media_id);

      createArgs.videoMediaId = slot.media_id;
      createArgs.coverImageUrl = input.coverImageUrl!;
      createArgs.destinationUrl = input.destinationUrl ?? input.coverImageUrl!;
    } else {
      // ─── Image pin path (existing behavior) ───────────────────────
      // Resolve to a public URL — mediaId → S3 URL, url → passthrough,
      // bytesBase64 → preflight_failed pointing at /v1/media.
      const resolved = await resolveMediaToUrl(mediaItem, {
        platform: "pinterest",
        reachableRule: "pinterest.media.reachable",
        ...(input.mediaContext
          ? {
              db: input.mediaContext.db,
              organizationId: input.mediaContext.organizationId,
              profileId: input.mediaContext.profileId,
            }
          : {}),
      });

      const reachableArgs: Parameters<typeof assertPinterestUrlsReachable>[0] = {
        imageUrl: resolved.url,
      };
      if (input.destinationUrl)
        reachableArgs.destinationUrl = input.destinationUrl;
      await assertPinterestUrlsReachable(reachableArgs);

      createArgs.destinationUrl = input.destinationUrl ?? resolved.url;
      createArgs.imageUrl = resolved.url;
    }

    const pin = await client.createPin(createArgs);

    if (!pin.id) {
      // Shouldn't happen — the client already validates; keep a loud fallback.
      throw new LetmepostError({
        code: "platform_rejected",
        status: 502,
        message: "Pinterest did not return a pin id.",
        platform: "pinterest",
      });
    }

    const response: PublishResult = {
      id: pin.id,
      platform: "pinterest",
      uri: pin.link ?? `https://www.pinterest.com/pin/${pin.id}/`,
      createdAt: new Date().toISOString(),
    };
    return response;
  },
};
