import type { MediaInput, PublishResult } from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";
import type { DecryptedPlatformAccount } from "../../repositories/platform-accounts.js";
import { blueskyPublisher } from "../bluesky/publisher.js";
import {
  validateBlueskyMediaShape,
  validateBlueskyText,
} from "../bluesky/preflight.js";
import { facebookPublisher } from "../facebook/publisher.js";
import {
  validateFacebookMediaShape,
  validateFacebookText,
} from "../facebook/preflight.js";
import { instagramPublisher } from "../instagram/publisher.js";
import {
  validateInstagramMediaShape,
  validateInstagramText,
} from "../instagram/preflight.js";
import { linkedinPublisher } from "../linkedin/publisher.js";
import { validateLinkedInText } from "../linkedin/preflight.js";
import { PinterestClient } from "../pinterest/client.js";
import { pinterestPublisher } from "../pinterest/publisher.js";
import type { PinterestTokenMetadata } from "../pinterest/provider.js";
import { threadsPublisher } from "../threads/publisher.js";
import {
  validateThreadsMediaShape,
  validateThreadsText,
} from "../threads/preflight.js";
import type { ThreadsTokenMetadata } from "../threads/provider.js";
import { assertTwitterLaunchCap } from "../twitter/launch-cap.js";
import { twitterPublisher } from "../twitter/publisher.js";
import {
  validateTwitterMediaShape,
  validateTwitterText,
} from "../twitter/preflight.js";
import type { DrizzleClient } from "../../db/index.js";
import type { MediaResolverContext } from "./media.js";

/**
 * Single source of truth for "given an account + a post body, run the right
 * publisher". Both the synchronous /v1/posts handler and the scheduled-post
 * worker route through here, which means adding a platform is one switch
 * case in this file — not two parallel edits.
 *
 * Per-platform input shapes are *load-bearing on types* (Pinterest needs
 * boardId/destinationUrl/imageUrl, Bluesky cares about firstComment, etc.),
 * so the dispatch is hand-rolled — a registry-callback abstraction would
 * either erase the type info or require a discriminated union per platform.
 * The hand-rolled switch is honest about what differs.
 *
 * Pinterest MVP carve-out: per-post boardId/destinationUrl/imageUrl ride on
 * `tokenMetadata` until the Phase 11 follow-up moves them into the request
 * body. Documented + asserted up front so nobody adds a third copy.
 */

export type PublishInput = {
  text: string;
  media?: Parameters<typeof blueskyPublisher.publish>[1]["media"];
  firstComment?: Parameters<typeof blueskyPublisher.publish>[1]["firstComment"];
  /**
   * Tenancy context for resolving `mediaId`-shaped inputs. Required when any
   * media item references a mediaId; URL / bytesBase64 paths ignore it.
   */
  mediaContext?: MediaResolverContext;
  /** Pinterest-specific per-post overrides (board, destination URL, title). */
  pinterest?: {
    boardId?: string;
    destinationUrl?: string;
    title?: string;
    coverImageUrl?: string;
  };
  /** Threads-specific per-post overrides (replyToId). */
  threads?: { replyToId?: string };
  /** X / Twitter-specific overrides (replyToTweetId, quoteTweetId). */
  twitter?: { replyToTweetId?: string; quoteTweetId?: string };
};

/**
 * Execution context for the dispatch layer. Required by pre-publish
 * gates (X launch cap, etc.) that need DB access — making `db` required
 * means a future caller can't accidentally skip the cost guard. Tests
 * that legitimately can't provide a DB connection set `skipGates: true`
 * to opt out explicitly, which is grep-able and reviewable.
 */
export type PublishContext =
  | { db: DrizzleClient; skipGates?: false }
  | { skipGates: true; db?: DrizzleClient };

/**
 * Hard cap on per-batch fan-out concurrency. Matches MAX_TARGETS_PER_REQUEST
 * (7) so by construction a single request can never exceed this limit — but
 * we keep the check here for callers (e.g. workers) that fan out from
 * outside the route boundary.
 */
export const MAX_FANOUT_CONCURRENCY = 7;

/**
 * Run `publishForAccount` across N (account, input) pairs concurrently.
 * Order of results matches input order so callers can correlate by index.
 *
 * Parallelism is capped at MAX_FANOUT_CONCURRENCY. The cap matches the
 * route-level target cap today, so for an in-route call this is effectively
 * "all at once" — but keeping the chunk loop here means a future caller
 * (e.g. a worker batch retry) that fans out beyond seven won't hammer
 * upstream APIs all at once.
 */
export async function publishAcrossTargets(
  items: ReadonlyArray<{
    account: DecryptedPlatformAccount;
    input: PublishInput;
  }>,
  ctx: PublishContext,
): Promise<PromiseSettledResult<PublishResult>[]> {
  const results: PromiseSettledResult<PublishResult>[] = new Array(items.length);
  for (let i = 0; i < items.length; i += MAX_FANOUT_CONCURRENCY) {
    const slice = items.slice(i, i + MAX_FANOUT_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map(({ account, input }) => publishForAccount(account, input, ctx)),
    );
    for (let j = 0; j < settled.length; j++) {
      results[i + j] = settled[j]!;
    }
  }
  return results;
}

/**
 * Cheap, synchronous-ish preflight — runs the shape checks each publisher
 * would do at the top of its publish() before any network I/O. Used by the
 * multi-target route to enforce atomic preflight: if any target's preflight
 * fails the whole batch is rejected BEFORE any publish side effects.
 *
 * Deep checks that need resolved media bytes (size limits, MIME sniffing,
 * URL reachability) still live inside the per-publisher publish(); those
 * failures surface as per-target errors in the response rather than batch
 * rejections.
 *
 * Throws LetmepostError with `code: "preflight_failed"` on failure.
 */
export function preflightForAccount(
  account: DecryptedPlatformAccount,
  input: PublishInput,
): void {
  const media = (input.media ?? []) as ReadonlyArray<MediaInput>;
  const shapeItems = media.map((m) => ({
    kind: m.kind,
    ...(m.altText !== undefined ? { altText: m.altText } : {}),
  }));

  switch (account.platform) {
    case "bluesky":
      validateBlueskyText(input.text);
      validateBlueskyMediaShape(shapeItems);
      return;
    case "linkedin":
      validateLinkedInText(input.text);
      return;
    case "twitter":
      validateTwitterText(input.text);
      validateTwitterMediaShape(shapeItems);
      return;
    case "facebook":
      validateFacebookText(input.text, shapeItems.length);
      validateFacebookMediaShape(shapeItems);
      return;
    case "instagram":
      validateInstagramText(input.text, shapeItems.length);
      validateInstagramMediaShape(shapeItems);
      return;
    case "threads":
      validateThreadsText(input.text, shapeItems.length);
      validateThreadsMediaShape(shapeItems);
      return;
    case "pinterest": {
      // Pinterest's hard preflight rule is "media required" — the board
      // requirement is checked in publishForAccount because surfacing
      // availableBoards needs a network call we don't want during a fan-out
      // preflight pass.
      if (media.length === 0) {
        throw new LetmepostError({
          code: "preflight_failed",
          status: 400,
          platform: "pinterest",
          message: "Pinterest posts require a media item.",
          rule: "pinterest.media.required",
          remediation:
            'Pass `media: [{ kind: "image", url | mediaId }]` on the request body.',
        });
      }
      return;
    }
    default:
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: `Unknown platform: ${account.platform}.`,
      });
  }
}

export async function publishForAccount(
  account: DecryptedPlatformAccount,
  input: PublishInput,
  ctx: PublishContext,
): Promise<PublishResult> {
  switch (account.platform) {
    case "bluesky": {
      const blueskyInput: Parameters<typeof blueskyPublisher.publish>[1] = {
        text: input.text,
      };
      if (input.media !== undefined) blueskyInput.media = input.media;
      if (input.firstComment !== undefined) {
        blueskyInput.firstComment = input.firstComment;
      }
      if (input.mediaContext !== undefined) {
        blueskyInput.mediaContext = input.mediaContext;
      }
      // Pull the user's PDS off tokenMetadata so self-hosted PDSes route
      // service-auth + image uploads correctly. The video service base
      // remains the canonical bsky.app endpoint regardless of PDS — it's
      // a single shared service across the network.
      const meta = (account.tokenMetadata ?? {}) as { pdsUrl?: string };
      const blueskyCreds: Parameters<typeof blueskyPublisher.publish>[0] = {
        handle: account.platformAccountId,
        appPassword: account.token,
      };
      if (typeof meta.pdsUrl === "string" && meta.pdsUrl.length > 0) {
        blueskyCreds.pdsUrl = meta.pdsUrl;
      }
      return blueskyPublisher.publish(blueskyCreds, blueskyInput);
    }
    case "linkedin": {
      const meta = (account.tokenMetadata ?? {}) as Record<string, unknown>;
      const authorUrn =
        typeof meta.authorUrn === "string" && meta.authorUrn.length > 0
          ? meta.authorUrn
          : `urn:li:person:${account.platformAccountId}`;
      return linkedinPublisher.publish(
        { accessToken: account.token, authorUrn },
        { text: input.text, authorUrn },
      );
    }
    case "twitter":
      // Launch-window cost cap on X. PPU billing means an uncapped
      // worker loop = real money out the door. Gate runs unless the
      // caller explicitly opted out via `skipGates: true`.
      if (!ctx.skipGates) {
        await assertTwitterLaunchCap(ctx.db!, account.id);
      }
      return twitterPublisher.publish(
        {
          accessToken: account.token,
          userId: account.platformAccountId,
        },
        {
          text: input.text,
          ...(input.media !== undefined ? { media: input.media } : {}),
          ...(input.mediaContext !== undefined
            ? { mediaContext: input.mediaContext }
            : {}),
          ...(input.twitter?.replyToTweetId !== undefined
            ? { replyToTweetId: input.twitter.replyToTweetId }
            : {}),
          ...(input.twitter?.quoteTweetId !== undefined
            ? { quoteTweetId: input.twitter.quoteTweetId }
            : {}),
        },
      );
    case "facebook":
      return facebookPublisher.publish(
        {
          accessToken: account.token,
          pageId: account.platformAccountId,
        },
        {
          text: input.text,
          ...(input.media !== undefined ? { media: input.media } : {}),
          ...(input.mediaContext !== undefined
            ? { mediaContext: input.mediaContext }
            : {}),
        },
      );
    case "instagram": {
      // Two paths produce instagram rows; the publisher hits a different
      // upstream host depending on which one provisioned this token:
      //   - FB Login fan-out (Page Access Token)  → graph.facebook.com
      //   - Instagram Login (IG user token)        → graph.instagram.com
      // Distinguished via tokenMetadata.kind, set by each provider on connect.
      const igMeta = (account.tokenMetadata ?? {}) as { kind?: string };
      const igGraphBase =
        igMeta.kind === "ig-login"
          ? process.env.INSTAGRAM_GRAPH_BASE ?? "https://graph.instagram.com"
          : undefined; // publisher default = META_GRAPH_BASE
      return instagramPublisher.publish(
        {
          accessToken: account.token,
          igUserId: account.platformAccountId,
          ...(igGraphBase ? { graphBase: igGraphBase } : {}),
        },
        {
          text: input.text,
          ...(input.media !== undefined ? { media: input.media } : {}),
          ...(input.mediaContext !== undefined
            ? { mediaContext: input.mediaContext }
            : {}),
        },
      );
    }
    case "threads": {
      const meta = (account.tokenMetadata ?? {}) as ThreadsTokenMetadata;
      // The Threads userId is pinned as platformAccountId at connect-time, but
      // we keep tokenMetadata.userId as the canonical reference because future
      // re-auth flows could rotate platformAccountId during a recovery path.
      const userId = meta.userId ?? account.platformAccountId;
      return threadsPublisher.publish(
        { accessToken: account.token, userId },
        {
          text: input.text,
          ...(input.media !== undefined ? { media: input.media } : {}),
          ...(input.threads?.replyToId !== undefined
            ? { replyToId: input.threads.replyToId }
            : {}),
          ...(input.mediaContext !== undefined
            ? { mediaContext: input.mediaContext }
            : {}),
        },
      );
    }
    case "pinterest": {
      const meta = (account.tokenMetadata ?? {}) as PinterestTokenMetadata;
      const boardId = input.pinterest?.boardId ?? meta.defaultBoardId;
      if (!boardId) {
        // Best-effort: surface the user's actual boards so the caller can
        // pick one without an extra round-trip. Already on the failure
        // path, so the extra Pinterest call is acceptable; if it fails
        // we just omit the hint rather than masking the real error.
        let availableBoards: { id: string; name: string }[] | undefined;
        try {
          const client = new PinterestClient(account.token);
          const boards = await client.listBoards({ pageSize: 25 });
          availableBoards = boards.map((b) => ({ id: b.id, name: b.name }));
        } catch {
          // intentional swallow — the publish error is what matters
        }
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          platform: "pinterest",
          message:
            "Pinterest posts need a board — none configured on the account and none on the request.",
          rule: "pinterest.board.required",
          remediation:
            "Set a default board via PATCH /v1/accounts/:id/pinterest/default-board, or pass `pinterest: { boardId }` on the request body. Use one of the ids in `platformResponse.availableBoards` below.",
          ...(availableBoards
            ? { platformResponse: { availableBoards } }
            : {}),
        });
      }
      if (!input.media || input.media.length === 0) {
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          platform: "pinterest",
          message: "Pinterest posts require a media item.",
          rule: "pinterest.media.required",
          remediation:
            "Pass `media: [{ kind: \"image\", url | mediaId }]` on the request body.",
        });
      }
      return pinterestPublisher.publish(
        { accessToken: account.token },
        {
          boardId,
          media: input.media,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.pinterest?.destinationUrl !== undefined
            ? { destinationUrl: input.pinterest.destinationUrl }
            : {}),
          ...(input.pinterest?.title !== undefined
            ? { title: input.pinterest.title }
            : {}),
          ...(input.pinterest?.coverImageUrl !== undefined
            ? { coverImageUrl: input.pinterest.coverImageUrl }
            : {}),
          ...(input.mediaContext !== undefined
            ? { mediaContext: input.mediaContext }
            : {}),
        },
      );
    }
    default:
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: `Unknown platform: ${account.platform}.`,
      });
  }
}
