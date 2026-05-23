import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  CreatePostRequest,
  MAX_TARGETS_PER_REQUEST,
  Platform,
  PostStatus,
  type CreatePostResponse,
  type MediaInput,
  type PostTarget,
  type PostTargetResult,
  type PublishResult,
  type WebhookEventType,
} from "@letmepost/schemas";
import { checkAndIncrementQuota } from "../billing/quota.js";
import { posts as postsTable, type Post } from "../db/schema/posts.js";
import { LetmepostError } from "../errors.js";
import { apiKeyAuth } from "../middleware/api-key.js";
import { apiKeyOrSession } from "../middleware/api-key-or-session.js";
import { idempotency } from "../middleware/idempotency.js";
import { assertKeyCanAccessProfile } from "../middleware/profile-scope.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  preflightForAccount,
  publishAcrossTargets,
  type PublishInput,
} from "../platforms/_shared/dispatch.js";
import {
  DrizzlePlatformAccountsRepository,
  type DecryptedPlatformAccount,
} from "../repositories/platform-accounts.js";
import {
  DrizzlePostsReadRepository,
  type PostListFilters,
  type PostWithAccount,
} from "../repositories/posts.js";

export const posts = new Hono();

// Per-route middleware chains:
//   POST /v1/posts          → strict API key + rate limit + idempotency
//   GET  /v1/posts          → API key OR dashboard session (read-only)
//   GET  /v1/posts/:id      → same as list
//
// Reads accept session because the dashboard talks to the same endpoint;
// writes stay strict-key only because idempotency / audit / billing are
// keyed on the api_keys row.

/**
 * Minimum future-delay before we accept a scheduled post, to avoid races
 * where the job fires before this transaction commits.
 */
const MIN_FUTURE_DELAY_MS = 1_000;

/**
 * Hybrid publish contract:
 *   - Immediate publish (no `scheduledAt`, or `publishNow: true`):
 *     synchronous fan-out across every target. Returns 200 with a per-target
 *     `results` array; the batch `status` is "published" when every target
 *     succeeded, "partial_failed" on mixed outcomes, "failed" when none did.
 *   - Scheduled publish (`scheduledAt` set in the future): each target is
 *     persisted with status="queued", a delayed job is enqueued per row,
 *     and the endpoint returns 202.
 *
 * Idempotency-Key applies to the whole batch — see middleware/idempotency.ts.
 * A retried fan-out replays the original CreatePostResponse (same batch id,
 * same per-target results) instead of re-publishing; changing any target
 * mid-retry surfaces as a 409 idempotency_conflict.
 *
 * Scheduled posts currently accept text only. Media and first-comment on
 * scheduled posts need persistent media storage (R2) and a dedicated
 * first-comment column — both land in a follow-up slice.
 */
posts.post(
  "/",
  apiKeyAuth(),
  rateLimit(),
  idempotency(),
  async (c) => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === undefined) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "Request body must be JSON.",
        rule: "body.json",
      });
    }

    const parsed = CreatePostRequest.safeParse(raw);
    if (!parsed.success) {
      throwZodValidationError(parsed.error);
    }
    const multi = parsed.data;

    const { organizationId } = c.var.apiKey;
    const repo = new DrizzlePlatformAccountsRepository(c.var.db);

    if (multi.targets.length === 0) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "Send at least one target on `targets[]`.",
        rule: "targets.required",
        remediation: "Pass `targets: [{ accountId, ... }]`.",
      });
    }
    if (multi.targets.length > MAX_TARGETS_PER_REQUEST) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: `A single request may not fan out to more than ${MAX_TARGETS_PER_REQUEST} targets.`,
        rule: "targets.max",
        remediation: `Split the publish into batches of at most ${MAX_TARGETS_PER_REQUEST} targets.`,
      });
    }
    if (multi.publishNow === true && multi.scheduledAt) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message:
          "Pass either `publishNow: true` or `scheduledAt`, not both.",
        rule: "mode_conflict",
        remediation:
          "Drop `scheduledAt` to publish immediately, or drop `publishNow` to schedule.",
      });
    }

    // ─── Resolve profile scope ───────────────────────────────────────────────
    // Precedence: explicit body.profileId wins when the key is org-wide.
    // A profile-scoped key forbids body.profileId from naming any OTHER
    // profile — that surfaces as a clean 400 instead of a 404 deep in the
    // resolver. Both null falls back to org-wide lookup.
    const keyProfileId = c.var.apiKey.profileId ?? null;
    const requestProfileId = multi.profileId ?? null;
    if (
      keyProfileId &&
      requestProfileId &&
      requestProfileId !== keyProfileId
    ) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        rule: "profile.scope_mismatch",
        message:
          "Explicit profileId does not match the profile this API key is scoped to.",
        remediation:
          "Omit profileId, or use an org-wide API key to target other profiles.",
      });
    }
    const profileId = requestProfileId ?? keyProfileId;

    // ─── Resolve accounts in parallel ────────────────────────────────────────
    // Each target carries either accountId, platform, or both. accountId →
    // direct lookup; platform-only → unique-account-for-platform within the
    // org+profile scope; both → lookup by id, verify platform agrees.
    const resolutions = await Promise.all(
      multi.targets.map((t) =>
        resolveTargetAccount(repo, organizationId, profileId, t),
      ),
    );

    const resolved: Array<{
      target: PostTarget;
      account: DecryptedPlatformAccount;
      input: PublishInput;
    }> = [];
    for (let i = 0; i < multi.targets.length; i++) {
      const target = multi.targets[i]!;
      const account = resolutions[i]!;
      // Profile-scope enforcement applies to every target. We 404 on
      // out-of-scope accounts so a profile-scoped key can't enumerate
      // accounts under sibling profiles.
      assertKeyCanAccessProfile(c.var.apiKey, account);

      // Per-target options must match the account's platform. Catching it
      // here yields a clean validation error vs. surfacing as garbage deep
      // in a publisher.
      if (
        target.options &&
        target.options.platform !== account.platform
      ) {
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          message: `Target options carry platform "${target.options.platform}" but the resolved account ${account.id} is a ${account.platform} account.`,
          rule: "targets.options.platform_mismatch",
          remediation:
            "Drop `options` or set `options.platform` to match the target's account platform.",
        });
      }

      const input = buildPublishInputForTarget(target, multi, account, c);
      resolved.push({ target, account, input });
    }

    // ─── Cheap preflight (atomic) ───────────────────────────────────────────
    // Synchronous shape-level checks (text length, media count + exclusivity,
    // alt-text length, platform-options sanity). If ANY target fails this
    // pass the whole batch is rejected — no posts row created, no upstream
    // call made. Deeper checks (URL reachability, MIME sniffing, byte caps)
    // happen inside each publisher and surface in `results[i].error`, which
    // means a batch can land as `partial_failed` if a per-target deep check
    // fails after persistence.
    for (const { account, input } of resolved) {
      preflightForAccount(account, input);
    }

    // ─── Billing quota gate ─────────────────────────────────────────────────
    // Idempotent replays never reach this code path. The idempotency
    // middleware short-circuits with the stored response before the handler
    // runs, so a retried key cannot double-charge the counter.
    //
    // Cost is one slot per target. Infinity quotas (self_host, grandfather,
    // enterprise) skip the cap entirely inside checkAndIncrementQuota.
    await checkAndIncrementQuota(c.var.db, organizationId, resolved.length, {
      webhookDispatcher: c.var.webhookDispatcher,
    });

    // ─── Scheduled path ──────────────────────────────────────────────────────
    if (multi.scheduledAt) {
      const when = new Date(multi.scheduledAt);
      const delayMs = when.getTime() - Date.now();
      if (delayMs < MIN_FUTURE_DELAY_MS) {
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          message: "scheduledAt must be at least 1 second in the future.",
          rule: "scheduledAt.future",
          remediation:
            "Send a timestamp at least 1 second ahead of now, or omit scheduledAt to publish immediately.",
        });
      }
      for (const { input } of resolved) {
        if (input.media || input.firstComment) {
          throw new LetmepostError({
            code: "validation_failed",
            status: 400,
            message:
              "Scheduled posts do not yet support media or firstComment — publish immediately or wait for the scheduled-media slice.",
            rule: "scheduledAt.text_only",
            remediation:
              "Drop media/firstComment from this request, or omit scheduledAt to publish synchronously.",
          });
        }
      }

      const batchId = randomUUID();
      const results: PostTargetResult[] = [];
      const createdAt = new Date();
      for (const { account, input } of resolved) {
        const [row] = await c.var.db
          .insert(postsTable)
          .values({
            organizationId,
            accountId: account.id,
            status: "queued",
            text: input.text,
            scheduledAt: when,
          })
          .returning();
        if (!row) {
          throw new LetmepostError({
            code: "internal_error",
            status: 500,
            message: "Failed to persist a scheduled post.",
          });
        }

        await c.var.publishEnqueuer.enqueue(
          {
            postId: row.id,
            organizationId,
            ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
          },
          { delayMs },
        );

        await c.var.webhookDispatcher.dispatch({
          organizationId,
          type: "post.queued",
          data: {
            id: row.id,
            platform: account.platform,
            accountId: account.id,
            profileId: account.profileId,
            scheduledAt: when.toISOString(),
            queuedAt: row.createdAt.toISOString(),
          },
          ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
        });

        results.push({
          accountId: account.id,
          platform: account.platform,
          postId: row.id,
          status: "queued",
        });
      }

      const body: CreatePostResponse = {
        id: batchId,
        status: "queued",
        createdAt: createdAt.toISOString(),
        scheduledAt: when.toISOString(),
        results,
      };
      return c.json(body, 202);
    }

    // ─── Immediate path — fan out across targets ────────────────────────────
    // Persist a `publishing` row per target up front so the post log shows
    // the in-flight state even mid-fan-out. Each target's outcome is
    // collected into the per-target result array.
    const persisted: Array<{
      account: DecryptedPlatformAccount;
      input: PublishInput;
      rowId: string;
    }> = [];
    for (const { account, input } of resolved) {
      const [row] = await c.var.db
        .insert(postsTable)
        .values({
          organizationId,
          accountId: account.id,
          status: "publishing",
          text: input.text,
          mediaRefs: input.media ? [...input.media] : [],
        })
        .returning();
      if (!row) {
        throw new LetmepostError({
          code: "internal_error",
          status: 500,
          message: "Failed to persist a post row.",
        });
      }
      persisted.push({ account, input, rowId: row.id });
    }

    const batchId = randomUUID();
    const createdAt = new Date();
    const settled = await publishAcrossTargets(
      persisted.map(({ account, input }) => ({ account, input })),
      { db: c.var.db },
    );

    const results: PostTargetResult[] = [];
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < persisted.length; i++) {
      const { account, rowId } = persisted[i]!;
      const outcome = settled[i]!;
      if (outcome.status === "fulfilled") {
        const result = outcome.value;
        successCount++;
        const publishedAt = new Date();
        await c.var.db
          .update(postsTable)
          .set({
            status: "published",
            platformUri: result.uri ?? null,
            platformCid: result.cid ?? null,
            publishedAt,
          })
          .where(eq(postsTable.id, rowId));

        await c.var.webhookDispatcher.dispatch({
          organizationId,
          type: "post.published",
          data: {
            id: rowId,
            platform: account.platform,
            accountId: account.id,
            profileId: account.profileId,
            uri: result.uri,
            cid: result.cid,
            firstCommentUri: result.firstCommentUri,
            firstCommentCid: result.firstCommentCid,
            publishedAt: publishedAt.toISOString(),
            warnings: result.warnings,
          },
          ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
        });

        results.push(buildSuccessResult(account, rowId, result));
      } else {
        failCount++;
        const err = outcome.reason;
        const { status, eventType } = classifyError(err);
        await c.var.db
          .update(postsTable)
          .set({
            status,
            error: letmepostErrorToRecord(err),
          })
          .where(eq(postsTable.id, rowId));

        if (eventType) {
          await c.var.webhookDispatcher
            .dispatch({
              organizationId,
              type: eventType,
              data: {
                id: rowId,
                platform: account.platform,
                accountId: account.id,
                profileId: account.profileId,
                error: letmepostErrorToRecord(err),
                rejectedAt: new Date().toISOString(),
              },
              ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
            })
            .catch((dispatchErr: unknown) => {
              console.error(
                "[posts] webhook dispatch failed after publish error",
                dispatchErr,
              );
            });
        }

        results.push(buildFailureResult(account, rowId, status, err));
      }
    }

    const batchStatus: CreatePostResponse["status"] =
      failCount === 0
        ? "published"
        : successCount === 0
          ? "failed"
          : "partial_failed";

    const body: CreatePostResponse = {
      id: batchId,
      status: batchStatus,
      createdAt: createdAt.toISOString(),
      results,
    };
    // 200 for the multi-target envelope regardless of mixed outcomes — the
    // batch itself completed; per-target errors are inside `results[]`. This
    // matches stripe-style "batch ack" semantics and keeps callers off the
    // exception path for the common partial-failure case.
    return c.json(body, 200);
  },
);

function throwZodValidationError(err: z.ZodError): never {
  const issue = err.issues[0];
  throw new LetmepostError({
    code: "validation_failed",
    status: 400,
    message: issue?.message ?? "Request body failed validation.",
    rule: issue?.path.join(".") || "body",
    platformResponse: err.issues,
    remediation: "Check the request body matches the documented schema.",
  });
}

/**
 * Resolve a target to its underlying platform account. The target may carry:
 *   - `accountId` alone: direct lookup.
 *   - `platform` alone: unique-account-for-platform lookup, scoped to the
 *     api key's profile. 0 matches → `target.account.not_connected`; 2+ →
 *     `target.account.ambiguous` with candidate ids.
 *   - Both: direct lookup, but verify the account's platform agrees with
 *     the hint — disagreement is `targets.account.platform_mismatch`.
 *
 * Cross-org and out-of-profile-scope accounts surface as 404 so a key
 * can't probe for account existence outside its blast radius.
 */
async function resolveTargetAccount(
  repo: DrizzlePlatformAccountsRepository,
  organizationId: string,
  profileId: string | null,
  target: PostTarget,
): Promise<DecryptedPlatformAccount> {
  if (target.accountId) {
    const account = await repo.findById(target.accountId);
    if (!account || account.organizationId !== organizationId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: `Platform account not found: ${target.accountId}.`,
        remediation:
          "Verify each `targets[].accountId` belongs to your organization.",
      });
    }
    if (target.platform && target.platform !== account.platform) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: `Target carries platform "${target.platform}" but accountId ${target.accountId} is a ${account.platform} account.`,
        rule: "targets.account.platform_mismatch",
        remediation:
          "Drop `platform` or set it to match the account's platform.",
      });
    }
    return account;
  }

  // platform-only auto-resolution — scoped by profile so a profile-scoped
  // key can't probe sibling-profile accounts via the ambiguity error.
  const platform = target.platform!;
  const lookup = await repo.findUniqueAccountForPlatform(
    organizationId,
    platform,
    profileId,
  );
  if (lookup.kind === "none") {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: `No connected ${platform} account in scope for this api key.`,
      rule: "target.account.not_connected",
      remediation: `Connect a ${platform} account via POST /v1/accounts/connect/${platform}, then retry.`,
    });
  }
  if (lookup.kind === "ambiguous") {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: `Multiple connected ${platform} accounts in scope — specify which one in targets[i].accountId.`,
      rule: "target.account.ambiguous",
      platformResponse: { candidates: lookup.candidateIds },
      remediation: `Pass one of the candidate ids on targets[i].accountId: ${lookup.candidateIds.join(", ")}.`,
    });
  }
  return lookup.account;
}

/**
 * Resolve a target's effective PublishInput by collapsing per-target
 * overrides over the request-level defaults. `options` is split back into
 * the per-platform fields the dispatcher already understands.
 */
function buildPublishInputForTarget(
  target: PostTarget,
  multi: CreatePostRequest,
  account: DecryptedPlatformAccount,
  c: { var: { db: unknown } },
): PublishInput {
  const text = target.text ?? multi.text;
  if (text === undefined) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: `Target for account ${account.id} has no text and no top-level default text.`,
      rule: "targets.text.required",
      remediation:
        "Set `text` at the top level, or on each target that needs distinct copy.",
    });
  }
  const media: MediaInput[] | undefined = target.media ?? multi.media;
  const firstComment = target.firstComment ?? multi.firstComment;

  const input: PublishInput = {
    text,
    mediaContext: {
      // c.var.db is a DrizzleClient — the runtime context type is opaque
      // at this helper boundary, hence the type narrowing.
      db: (c.var as { db: unknown }).db as never,
      organizationId: account.organizationId,
      profileId: account.profileId,
    },
  };
  if (media !== undefined) input.media = media;
  if (firstComment !== undefined) input.firstComment = firstComment;

  if (target.options) {
    if (target.options.platform === "twitter") {
      const tw: NonNullable<PublishInput["twitter"]> = {};
      if (target.options.replyToTweetId !== undefined) {
        tw.replyToTweetId = target.options.replyToTweetId;
      }
      if (target.options.quoteTweetId !== undefined) {
        tw.quoteTweetId = target.options.quoteTweetId;
      }
      input.twitter = tw;
    } else if (target.options.platform === "pinterest") {
      const pin: NonNullable<PublishInput["pinterest"]> = {};
      if (target.options.boardId !== undefined) pin.boardId = target.options.boardId;
      if (target.options.destinationUrl !== undefined) {
        pin.destinationUrl = target.options.destinationUrl;
      }
      if (target.options.title !== undefined) pin.title = target.options.title;
      if (target.options.coverImageUrl !== undefined) {
        pin.coverImageUrl = target.options.coverImageUrl;
      }
      input.pinterest = pin;
    } else if (target.options.platform === "threads") {
      const thr: NonNullable<PublishInput["threads"]> = {};
      if (target.options.replyToId !== undefined) {
        thr.replyToId = target.options.replyToId;
      }
      input.threads = thr;
    } else if (target.options.platform === "tiktok") {
      const tt: NonNullable<PublishInput["tiktok"]> = {};
      if (target.options.privacy !== undefined) tt.privacy = target.options.privacy;
      if (target.options.disableComment !== undefined) {
        tt.disableComment = target.options.disableComment;
      }
      if (target.options.disableDuet !== undefined) {
        tt.disableDuet = target.options.disableDuet;
      }
      if (target.options.disableStitch !== undefined) {
        tt.disableStitch = target.options.disableStitch;
      }
      if (target.options.brandContentToggle !== undefined) {
        tt.brandContentToggle = target.options.brandContentToggle;
      }
      if (target.options.brandOrganicToggle !== undefined) {
        tt.brandOrganicToggle = target.options.brandOrganicToggle;
      }
      input.tiktok = tt;
    }
  }

  return input;
}

function buildSuccessResult(
  account: DecryptedPlatformAccount,
  postId: string,
  result: PublishResult,
): PostTargetResult {
  const out: PostTargetResult = {
    accountId: account.id,
    platform: account.platform,
    postId,
    status: "published",
  };
  if (result.uri !== undefined) out.uri = result.uri;
  if (result.cid !== undefined) out.cid = result.cid;
  if (result.firstCommentUri !== undefined) {
    out.firstCommentUri = result.firstCommentUri;
  }
  if (result.firstCommentCid !== undefined) {
    out.firstCommentCid = result.firstCommentCid;
  }
  if (result.warnings !== undefined) out.warnings = result.warnings;
  return out;
}

function buildFailureResult(
  account: DecryptedPlatformAccount,
  postId: string,
  status: "rejected" | "failed",
  err: unknown,
): PostTargetResult {
  const out: PostTargetResult = {
    accountId: account.id,
    platform: account.platform,
    postId,
    status,
  };
  if (err instanceof LetmepostError) {
    const errObj: PostTargetResult["error"] = {
      code: err.code,
      message: err.message,
    };
    if (err.rule !== undefined) errObj.rule = err.rule;
    if (err.remediation !== undefined) errObj.remediation = err.remediation;
    if (err.platformResponse !== undefined) {
      errObj.platformResponse = err.platformResponse;
    }
    out.error = errObj;
  } else {
    out.error = {
      code: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Post Log — read endpoints
 * Both inherit the route's API-key auth + rate limit; idempotency only
 * matters on writes, so we don't double-charge reads against the replay
 * cache.
 * ───────────────────────────────────────────────────────────────────────── */

const ListPostsQuery = z.object({
  profileId: z.string().uuid().optional(),
  platform: z.array(Platform).optional(),
  status: z.array(PostStatus).optional(),
  errorCode: z.array(z.string().min(1)).optional(),
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

function publicView(post: PostWithAccount) {
  return {
    id: post.id,
    profileId: post.account.profileId,
    accountId: post.accountId,
    account: {
      id: post.account.id,
      platform: post.account.platform,
      platformAccountId: post.account.platformAccountId,
      displayName: post.account.displayName,
    },
    platform: post.account.platform,
    status: post.status,
    text: post.text,
    mediaRefs: post.mediaRefs,
    scheduledAt: post.scheduledAt,
    publishedAt: post.publishedAt,
    platformUri: post.platformUri,
    platformCid: post.platformCid,
    error: post.error,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

/**
 * Coerce repeated query params (`?platform=a&platform=b`) into an array.
 * Also accepts comma-separated single values (`?platform=a,b`) — both are
 * common conventions and integrators shouldn't have to remember which.
 */
function readArrayQuery(
  c: { req: { queries: (k: string) => string[] | undefined } },
  key: string,
): string[] | undefined {
  const values = c.req.queries(key);
  if (!values || values.length === 0) return undefined;
  const flat = values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  return flat.length > 0 ? flat : undefined;
}

posts.get("/", apiKeyOrSession(), async (c) => {
  const rawQuery = {
    profileId: c.req.query("profileId"),
    platform: readArrayQuery(c, "platform"),
    status: readArrayQuery(c, "status"),
    errorCode: readArrayQuery(c, "errorCode"),
    after: c.req.query("after"),
    before: c.req.query("before"),
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  };
  const parsed = ListPostsQuery.safeParse(rawQuery);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: issue?.message ?? "Invalid query parameters.",
      rule: issue?.path.join(".") || "query",
      platformResponse: parsed.error.issues,
    });
  }
  const q = parsed.data;
  const { organizationId, profileId: keyProfileId } = c.var.apiKey;

  // Profile-scope enforcement on list:
  //   - org-wide key (NULL) — caller's ?profileId is honored as-is
  //   - profile-scoped key — must match (or omit) ?profileId; otherwise 404
  let effectiveProfileId: string | null | undefined = keyProfileId ?? undefined;
  if (q.profileId !== undefined) {
    if (keyProfileId !== null && keyProfileId !== q.profileId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Profile not found.",
        rule: "api_key.profile_scope",
      });
    }
    effectiveProfileId = q.profileId;
  }

  const filters: PostListFilters = { organizationId };
  if (effectiveProfileId) filters.profileId = effectiveProfileId;
  if (q.platform) filters.platforms = q.platform;
  if (q.status) filters.statuses = q.status as Post["status"][];
  if (q.errorCode) filters.errorCodes = q.errorCode;
  if (q.after) filters.after = new Date(q.after);
  if (q.before) filters.before = new Date(q.before);

  const repo = new DrizzlePostsReadRepository(c.var.db);
  const result = await repo.list(filters, {
    limit: q.limit ?? 50,
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });

  return c.json({
    data: result.data.map(publicView),
    nextCursor: result.nextCursor,
  });
});

posts.get("/:id", apiKeyOrSession(), async (c) => {
  const id = c.req.param("id");
  const { organizationId } = c.var.apiKey;
  const repo = new DrizzlePostsReadRepository(c.var.db);
  const post = await repo.findByIdWithAccount(id);
  if (!post || post.organizationId !== organizationId) {
    throw new LetmepostError({
      code: "not_found",
      status: 404,
      message: "Post not found.",
    });
  }
  // Profile scope: same 404-not-403 contract as POST /v1/posts.
  assertKeyCanAccessProfile(c.var.apiKey, post.account);

  const attempts = await repo.attemptsFor(id);

  return c.json({
    ...publicView(post),
    attempts: attempts.map((a) => ({
      id: a.id,
      attemptNumber: a.attemptNumber,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      succeeded: a.succeeded,
      errorCode: a.errorCode,
      errorMessage: a.errorMessage,
      platformResponse: a.platformResponse,
    })),
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Mutations on scheduled posts — reschedule + cancel
 * Both share the same precondition: status=queued AND scheduledAt is in the
 * future. Once a post has fired (publishing/published/failed/rejected) the
 * window for these is closed.
 *
 * Auth is apiKeyOrSession so the dashboard can call these directly with a
 * cookie session; programmatic callers use an API key. Profile scope is
 * enforced identically to GET /v1/posts/:id (404 not 403).
 * ───────────────────────────────────────────────────────────────────────── */

const PatchPostBody = z.object({
  scheduledAt: z.string().datetime(),
});

async function loadModifiableScheduled(
  c: {
    var: {
      db: import("../db/index.js").DrizzleClient;
      apiKey: { organizationId: string; profileId: string | null };
    };
    req: { param: (k: string) => string };
  },
): Promise<PostWithAccount> {
  const id = c.req.param("id");
  const { organizationId } = c.var.apiKey;
  const repo = new DrizzlePostsReadRepository(c.var.db);
  const post = await repo.findByIdWithAccount(id);
  if (!post || post.organizationId !== organizationId) {
    throw new LetmepostError({
      code: "not_found",
      status: 404,
      message: "Post not found.",
    });
  }
  assertKeyCanAccessProfile(c.var.apiKey, post.account);
  if (post.status !== "queued") {
    throw new LetmepostError({
      code: "validation_failed",
      status: 409,
      message: `Cannot modify a post in status "${post.status}". Only queued scheduled posts can be rescheduled or canceled.`,
      rule: "post.status",
    });
  }
  if (!post.scheduledAt || post.scheduledAt.getTime() <= Date.now()) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 409,
      message: "This post is already firing or has no scheduledAt. The window for changes has closed.",
      rule: "post.scheduledAt.window",
    });
  }
  return post;
}

posts.patch("/:id", apiKeyOrSession(), async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = PatchPostBody.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: issue?.message ?? "Invalid request body.",
      rule: issue?.path.join(".") || "body",
      platformResponse: parsed.error.issues,
    });
  }
  const post = await loadModifiableScheduled(c);
  const when = new Date(parsed.data.scheduledAt);
  const delayMs = when.getTime() - Date.now();
  if (delayMs < MIN_FUTURE_DELAY_MS) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: "scheduledAt must be at least 1 second in the future.",
      rule: "scheduledAt.future",
      remediation:
        "Send a timestamp at least 1 second ahead of now.",
    });
  }

  // Replace the BullMQ job first. If this fails the row stays as-is and the
  // caller can retry; if we updated the row first and the queue op blew up
  // we'd have a row out of sync with a job that still fires at the old time.
  await c.var.publishEnqueuer.remove(post.id);
  await c.var.publishEnqueuer.enqueue(
    {
      postId: post.id,
      organizationId: post.organizationId,
      ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
    },
    { delayMs },
  );
  await c.var.db
    .update(postsTable)
    .set({ scheduledAt: when })
    .where(eq(postsTable.id, post.id));

  await c.var.webhookDispatcher.dispatch({
    organizationId: post.organizationId,
    type: "post.rescheduled",
    data: {
      id: post.id,
      platform: post.account.platform,
      accountId: post.accountId,
      profileId: post.account.profileId,
      previousScheduledAt: post.scheduledAt?.toISOString(),
      scheduledAt: when.toISOString(),
    },
    ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
  });

  return c.json({
    ...publicView({ ...post, scheduledAt: when }),
  });
});

posts.delete("/:id", apiKeyOrSession(), async (c) => {
  const post = await loadModifiableScheduled(c);

  await c.var.publishEnqueuer.remove(post.id);
  await c.var.db
    .update(postsTable)
    .set({ status: "canceled" })
    .where(eq(postsTable.id, post.id));

  await c.var.webhookDispatcher.dispatch({
    organizationId: post.organizationId,
    type: "post.canceled",
    data: {
      id: post.id,
      platform: post.account.platform,
      accountId: post.accountId,
      profileId: post.account.profileId,
      scheduledAt: post.scheduledAt?.toISOString(),
      canceledAt: new Date().toISOString(),
    },
    ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
  });

  return c.json({ id: post.id, status: "canceled" });
});

function classifyError(err: unknown): {
  status: "rejected" | "failed";
  eventType: WebhookEventType | null;
} {
  if (!(err instanceof LetmepostError)) {
    return { status: "failed", eventType: "post.failed" };
  }
  switch (err.code) {
    case "preflight_failed":
    case "platform_auth_failed":
    case "platform_rejected":
      return { status: "rejected", eventType: "post.rejected" };
    case "platform_unavailable":
    case "internal_error":
      return { status: "failed", eventType: "post.failed" };
    default:
      // validation_failed / not_found / unauthenticated / etc. happen before
      // the posts row insert, so they shouldn't reach here — but if they do,
      // mark the row as failed without dispatching an event.
      return { status: "failed", eventType: null };
  }
}

function letmepostErrorToRecord(err: unknown): Record<string, unknown> {
  if (err instanceof LetmepostError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.rule ? { rule: err.rule } : {}),
      ...(err.platform ? { platform: err.platform } : {}),
      ...(err.platformVersion ? { platformVersion: err.platformVersion } : {}),
      ...(err.platformResponse !== undefined
        ? { platformResponse: err.platformResponse }
        : {}),
      ...(err.remediation ? { remediation: err.remediation } : {}),
    };
  }
  return {
    code: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

