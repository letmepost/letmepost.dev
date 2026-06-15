import type { PublishResult, MediaInput } from "@letmepost/schemas";
import {
  loadMediaItem as sharedLoadMediaItem,
  type LoadedMediaItem as SharedLoadedMediaItem,
  type MediaResolverContext,
} from "../_shared/media.js";
import type { Publisher } from "../_shared/publisher.js";
import {
  BlueskyClient,
  type BlueskyBlobRef,
  type BlueskyCreatePostInput,
  type BlueskyEmbed,
  type BlueskyPostResult,
  type BlueskySession,
} from "./client.js";
import {
  type ResolvedMediaItem,
  validateBlueskyFirstComment,
  validateBlueskyMedia,
  validateBlueskyMediaShape,
  validateBlueskyText,
} from "./preflight.js";
import {
  BLUESKY_VIDEO_BASE,
  getServiceAuth,
  getUploadLimits,
  pollJobUntilComplete,
  uploadVideo,
} from "./video.js";
import { LetmepostError } from "../../errors.js";

/**
 * Credentials the Bluesky publisher needs to authenticate + post. Callers
 * resolve these from a stored platform_account via the repository — the
 * publisher never touches the DB directly.
 */
export type BlueskyCredentials = {
  /** Bluesky handle or email used at createSession time. */
  handle: string;
  /** Decrypted app password. */
  appPassword: string;
  /** Override the user's PDS — defaults to bsky.social. */
  pdsUrl?: string;
  /** Override the video service base — tests point at MSW. */
  videoBase?: string;
};

export type BlueskyPublishInput = {
  text: string;
  media?: MediaInput[];
  firstComment?: { text: string };
  /** Required only if any media item references a `mediaId`. */
  mediaContext?: MediaResolverContext;
  replyTo?: {
    uri: string;
    cid: string;
    root?: { uri: string; cid: string };
  };
};

/** A media item with bytes resolved, ready for preflight + upload. */
type LoadedMediaItem = SharedLoadedMediaItem;

function loadMediaItem(
  item: MediaInput,
  ctx: MediaResolverContext | undefined,
): Promise<LoadedMediaItem> {
  return sharedLoadMediaItem(item, {
    platform: "bluesky",
    reachableRule: "bluesky.media.reachable",
    ...(ctx
      ? {
          db: ctx.db,
          organizationId: ctx.organizationId,
          profileId: ctx.profileId,
        }
      : {}),
  });
}

function buildEmbed(
  items: LoadedMediaItem[],
  blobRefs: BlueskyBlobRef[],
): BlueskyEmbed | undefined {
  if (items.length === 0) return undefined;
  // Invariant enforced by preflight: all-image OR single-video, never mixed.
  if (items[0]!.kind === "video") {
    return {
      $type: "app.bsky.embed.video",
      video: blobRefs[0]!,
      alt: items[0]!.altText ?? "",
    };
  }
  return {
    $type: "app.bsky.embed.images",
    images: items.map((item, i) => ({
      image: blobRefs[i]!,
      alt: item.altText ?? "",
    })),
  };
}

async function publishFirstComment(
  client: BlueskyClient,
  session: BlueskySession,
  text: string,
  mainPost: BlueskyPostResult,
): Promise<BlueskyPostResult> {
  validateBlueskyFirstComment(text);
  return client.createPost(session, {
    text,
    reply: {
      root: { uri: mainPost.uri, cid: mainPost.cid },
      parent: { uri: mainPost.uri, cid: mainPost.cid },
    },
  });
}

export const blueskyPublisher: Publisher<BlueskyCredentials, BlueskyPublishInput> = {
  async publish(creds, input): Promise<PublishResult> {
    const { text, media = [], firstComment, mediaContext, replyTo } = input;

    validateBlueskyText(text);

    // Cheap shape checks first (count, image/video exclusivity, alt-text
    // length) — these don't need resolved bytes, so failing here saves
    // a 4-image fetch storm when someone sends 5.
    validateBlueskyMediaShape(
      media.map((m) => {
        const item: { kind: "image" | "video"; altText?: string } = {
          kind: m.kind,
        };
        if (m.altText !== undefined) item.altText = m.altText;
        return item;
      }),
    );

    // Then resolve bytes (so size + mime preflight is honest), then run
    // the byte-aware preflight, then upload. If any step fails, we never
    // hit upstream.
    const loaded = await Promise.all(
      media.map((item) => loadMediaItem(item, mediaContext)),
    );
    validateBlueskyMedia(
      loaded.map((l) => {
        const item: ResolvedMediaItem = {
          kind: l.kind,
          mimeType: l.mimeType,
          byteLength: l.byteLength,
        };
        if (l.altText !== undefined) item.altText = l.altText;
        return item;
      }),
    );

    // firstComment preflight is cheap + doesn't need the session; run it early
    // so a bad comment fails before we spend upstream calls on the main post.
    if (firstComment) validateBlueskyFirstComment(firstComment.text);

    const pdsUrl = creds.pdsUrl ?? "https://bsky.social";
    const videoBase = creds.videoBase ?? BLUESKY_VIDEO_BASE;
    const client = new BlueskyClient(creds.handle, creds.appPassword, pdsUrl);
    const session = await client.createSession();

    // Upload each media item via the right pipe:
    //   - image → com.atproto.repo.uploadBlob (fast, blob-ref returned)
    //   - video → app.bsky.video.uploadVideo on the video service +
    //             poll app.bsky.video.getJobStatus until COMPLETED, then
    //             use the returned blob ref. Required because the image
    //             upload endpoint can't produce a playable video blob.
    const blobRefs: BlueskyBlobRef[] = [];
    for (const item of loaded) {
      if (item.kind === "video") {
        const serviceAuth = await getServiceAuth(session, pdsUrl);

        // Cheap pre-check: ask the video service whether the user has
        // any daily quota left. Failing here is much louder than letting
        // the upload 200 and the job state flip to FAILED a minute later.
        const limits = await getUploadLimits(serviceAuth);
        if (limits && limits.canUpload === false) {
          throw new LetmepostError({
            code: "preflight_failed",
            status: 400,
            platform: "bluesky",
            message:
              limits.message ??
              "Bluesky reports the account is out of daily video upload quota.",
            rule: "bluesky.video.quota_exhausted",
            remediation:
              "Bluesky enforces a per-user daily cap on video uploads + total bytes. Wait for the quota to reset or use a different account.",
            platformResponse: limits,
          });
        }

        const filename = `lmp-${Date.now()}.mp4`;
        const job = await uploadVideo(
          serviceAuth,
          session.did,
          filename,
          item.bytes,
          item.mimeType,
          videoBase,
        );

        // Bluesky dedupes by content hash, so a re-upload of the same
        // bytes can land in COMPLETED on the first response with a blob
        // already attached. Skip the poll in that case.
        const ref =
          job.state === "JOB_STATE_COMPLETED" && job.blob
            ? job.blob
            : await pollJobUntilComplete(serviceAuth, job.jobId, {
                videoBase,
              });
        blobRefs.push(ref);
      } else {
        const ref = await client.uploadBlob(session, item.bytes, item.mimeType);
        blobRefs.push(ref);
      }
    }

    const embed = buildEmbed(loaded, blobRefs);

    const mainInput: BlueskyCreatePostInput = { text };
    if (embed) mainInput.embed = embed;
    if (replyTo) {
      mainInput.reply = {
        root: replyTo.root ?? { uri: replyTo.uri, cid: replyTo.cid },
        parent: { uri: replyTo.uri, cid: replyTo.cid },
      };
    }
    const main = await client.createPost(session, mainInput);

    const response: PublishResult = {
      id: main.cid,
      platform: "bluesky",
      uri: main.uri,
      cid: main.cid,
      createdAt: new Date().toISOString(),
    };

    // First-comment semantics: if the main post succeeded but the reply fails,
    // we DO NOT roll back or error out. The user's content is live; we surface
    // the failure as a warning so callers can retry the reply independently.
    // Rationale: undoing a successful publish on a distributed PDS is racy and
    // surprising; losing the first comment is a recoverable failure.
    if (firstComment) {
      try {
        const reply = await publishFirstComment(
          client,
          session,
          firstComment.text,
          main,
        );
        response.firstCommentUri = reply.uri;
        response.firstCommentCid = reply.cid;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "First-comment publish failed.";
        response.warnings = [
          ...(response.warnings ?? []),
          {
            code: "first_comment_failed",
            message,
          },
        ];
      }
    }

    return response;
  },
};
