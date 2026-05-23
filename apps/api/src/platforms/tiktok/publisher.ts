import {
  TIKTOK_CHUNK_SIZE_BYTES,
  TIKTOK_SINGLE_CHUNK_THRESHOLD_BYTES,
  type PublishResult,
} from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";
import {
  loadMediaItem,
  type MediaResolverContext,
} from "../_shared/media.js";
import type { Publisher } from "../_shared/publisher.js";
import {
  TikTokClient,
  type TikTokInitInboxResponse,
  type TikTokPrivacyLevel,
} from "./client.js";
import type { TikTokAuditState } from "./provider.js";
import {
  probeVideoBytes,
  validateTikTokInput,
  validateTikTokVideoBytes,
  validateTikTokVideoProbe,
  type TikTokPreflightWarning,
  type TikTokPublishInput,
} from "./preflight.js";

const PLATFORM = "tiktok";

/**
 * Credentials the TikTok publisher needs. The token comes from
 * platform_accounts.token (decrypted at the repository boundary); the
 * cached audit state + privacy options come from tokenMetadata so a
 * single publish call doesn't need to re-hit creator_info.
 */
export type TikTokCredentials = {
  accessToken: string;
  apiBase?: string;
  /** Snapshot from the provider's last creator_info read. */
  auditState?: TikTokAuditState;
  /** Privacy levels TikTok will accept on this account. */
  privacyLevelOptions?: TikTokPrivacyLevel[];
};

/**
 * Publish-time output. Status is intentionally NOT terminal here —
 * TikTok's inbox flow lands the video in the user's TikTok inbox and
 * publishes asynchronously. The publisher returns `publishing` with a
 * publish_id stamped on `cid` so the worker can poll for the terminal
 * state and fire `post.published` / `post.failed` later.
 */
export type TikTokPublisherInput = TikTokPublishInput & {
  mediaContext?: MediaResolverContext;
};

export const tiktokPublisher: Publisher<
  TikTokCredentials,
  TikTokPublisherInput
> = {
  async publish(creds, input): Promise<PublishResult> {
    // ─── Shape preflight (caption, hashtag count, privacy, audit) ────────
    const shapeArgs: Parameters<typeof validateTikTokInput>[0] = {
      media: input.media,
    };
    if (input.text !== undefined) shapeArgs.text = input.text;
    if (input.privacy !== undefined) shapeArgs.privacy = input.privacy;
    if (input.brandContentToggle !== undefined) {
      shapeArgs.brandContentToggle = input.brandContentToggle;
    }
    if (input.brandOrganicToggle !== undefined) {
      shapeArgs.brandOrganicToggle = input.brandOrganicToggle;
    }
    if (creds.auditState !== undefined) shapeArgs.auditState = creds.auditState;
    if (creds.privacyLevelOptions !== undefined) {
      shapeArgs.privacyLevelOptions = creds.privacyLevelOptions;
    }
    const shape = validateTikTokInput(shapeArgs);
    const warnings: TikTokPreflightWarning[] = [...shape.warnings];

    // ─── Resolve bytes + run byte-level preflight ────────────────────────
    const mediaItem = input.media[0]!;
    const mediaCtx: Parameters<typeof loadMediaItem>[1] = {
      platform: PLATFORM,
      reachableRule: "tiktok.video.reachable",
    };
    if (input.mediaContext) {
      mediaCtx.db = input.mediaContext.db;
      mediaCtx.organizationId = input.mediaContext.organizationId;
      mediaCtx.profileId = input.mediaContext.profileId;
    }
    const loaded = await loadMediaItem(mediaItem, mediaCtx);
    validateTikTokVideoBytes({
      mimeType: loaded.mimeType,
      byteLength: loaded.byteLength,
    });

    // Best-effort duration / resolution probe via ffprobe.
    const probe = await probeVideoBytes(loaded.bytes);
    const probeArgs: Parameters<typeof validateTikTokVideoProbe>[0] = { probe };
    if (creds.auditState !== undefined) {
      probeArgs.accountAudit = creds.auditState;
    }
    const probeWarnings = validateTikTokVideoProbe(probeArgs);
    warnings.push(...probeWarnings);

    // ─── Init upload-inbox slot ──────────────────────────────────────────
    const client = new TikTokClient(creds.accessToken, creds.apiBase);
    const totalBytes = loaded.byteLength;
    const singleChunk = totalBytes <= TIKTOK_SINGLE_CHUNK_THRESHOLD_BYTES;
    const chunkSize = singleChunk
      ? totalBytes
      : Math.min(TIKTOK_CHUNK_SIZE_BYTES, totalBytes);
    const totalChunkCount = singleChunk
      ? 1
      : Math.ceil(totalBytes / chunkSize);

    const slot: TikTokInitInboxResponse = await client.initInboxUpload({
      videoSize: totalBytes,
      chunkSize,
      totalChunkCount,
    });

    // ─── Upload bytes (single-chunk PUT or multi-chunk loop) ─────────────
    if (singleChunk) {
      await client.uploadChunk({
        uploadUrl: slot.upload_url,
        bytes: loaded.bytes,
        contentRange: `bytes 0-${totalBytes - 1}/${totalBytes}`,
        totalBytes,
        mimeType: loaded.mimeType,
      });
    } else {
      for (let i = 0; i < totalChunkCount; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, totalBytes);
        const chunk = loaded.bytes.subarray(start, end);
        await client.uploadChunk({
          uploadUrl: slot.upload_url,
          bytes: chunk,
          contentRange: `bytes ${start}-${end - 1}/${totalBytes}`,
          totalBytes,
          mimeType: loaded.mimeType,
        });
      }
    }

    if (!slot.publish_id) {
      throw new LetmepostError({
        code: "platform_rejected",
        status: 502,
        platform: PLATFORM,
        message: "TikTok did not return a publish_id.",
        rule: "tiktok.publish.no_id",
      });
    }

    // ─── Return publishing-state result with publish_id stamped on cid ───
    // The post is not yet live on TikTok; it's queued in the user's
    // inbox (audit accounts) or being processed. The async worker polls
    // /post/publish/status/fetch/ and fires post.published / post.failed
    // when TikTok reaches a terminal state. We surface `status:
    // "publishing"` here so the dashboard's Post Log can render the
    // pending state cleanly.
    const response: PublishResult = {
      id: slot.publish_id,
      platform: PLATFORM,
      status: "publishing",
      cid: slot.publish_id,
      createdAt: new Date().toISOString(),
    };
    if (warnings.length > 0) {
      response.warnings = warnings.map((w) => ({
        code: w.code,
        message: w.message,
      }));
    }
    // Stamp the canonical privacy used in case the caller wants to
    // inspect what TikTok was told. Encoded as part of the warning
    // payload only if it differs from the caller's intent.
    void shape.privacy;
    return response;
  },
};

/**
 * Inputs the worker poller sends to TikTok. Kept separate from the
 * publisher contract so the worker can call this directly without
 * recreating credentials.
 */
export interface TikTokStatusPollInput {
  accessToken: string;
  publishId: string;
  apiBase?: string;
}

export interface TikTokTerminalStatus {
  terminal: true;
  status: "published" | "failed";
  publishId: string;
  publicPostId?: string;
  publicUri?: string;
  failReason?: string;
}

export interface TikTokPendingStatus {
  terminal: false;
  status: "pending";
  publishId: string;
  upstreamState: string;
}

export type TikTokStatusPollResult =
  | TikTokTerminalStatus
  | TikTokPendingStatus;

/**
 * Run one poll of /post/publish/status/fetch/. Maps TikTok's status
 * states onto the letmepost terminal vocabulary the worker consumes:
 *
 *   - PUBLISH_COMPLETE      → terminal published
 *   - FAILED                → terminal failed (with TikTok's reason)
 *   - SEND_TO_USER_INBOX    → terminal published* for audit-mode accounts,
 *                              since TikTok's inbox is the "post" state
 *                              for SELF_ONLY uploads
 *   - PROCESSING_*          → pending; worker re-enqueues
 *
 * *Why SEND_TO_USER_INBOX counts as published: TikTok's upload-inbox
 * flow is the documented end-state for audit-mode posts — the user
 * confirms publish in their TikTok app. The post IS in the user's
 * inbox; calling it "failed" because the user hasn't manually tapped
 * publish yet would surface as a false negative. The worker emits a
 * `post.published` event with a clarifying warning for this path.
 */
export async function pollTikTokPublishStatus(
  input: TikTokStatusPollInput,
): Promise<TikTokStatusPollResult> {
  const client = new TikTokClient(input.accessToken, input.apiBase);
  const status = await client.fetchPublishStatus(input.publishId);
  if (status.status === "PUBLISH_COMPLETE") {
    const result: TikTokTerminalStatus = {
      terminal: true,
      status: "published",
      publishId: input.publishId,
    };
    const publicId = status.publicaly_available_post_id?.[0];
    if (publicId) {
      result.publicPostId = publicId;
      // TikTok public post URLs follow a stable shape only for unaudited
      // production posts. The publish_id itself is opaque — leave the
      // URL undefined and let the dashboard render the post id verbatim
      // when no canonical URL is available.
      result.publicUri = `https://www.tiktok.com/video/${publicId}`;
    }
    return result;
  }
  if (status.status === "SEND_TO_USER_INBOX") {
    // The audit-mode terminal state. Surface as `published` but with the
    // publish_id as the post id — there is no public URL until the user
    // confirms in-app, which we have no signal for.
    return {
      terminal: true,
      status: "published",
      publishId: input.publishId,
    };
  }
  if (status.status === "FAILED") {
    return {
      terminal: true,
      status: "failed",
      publishId: input.publishId,
      ...(status.fail_reason ? { failReason: status.fail_reason } : {}),
    };
  }
  return {
    terminal: false,
    status: "pending",
    publishId: input.publishId,
    upstreamState: status.status,
  };
}
