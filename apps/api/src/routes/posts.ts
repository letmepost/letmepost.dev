import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  CreatePostRequest,
  MAX_TARGETS_PER_REQUEST,
  MediaInput,
  Platform,
  PostStatus,
  type CreatePostResponse,
  type PostTarget,
  type PostTargetResult,
  type PublishResult,
  type WebhookEventType,
} from "@letmepost/schemas";
import { checkAndIncrementQuota, decrementQuota } from "../billing/quota.js";
import type { DrizzleClient } from "../db/index.js";
import { posts as postsTable, type Post } from "../db/schema/posts.js";
import { LetmepostError } from "../errors.js";
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
import type { WebhookDispatcher } from "../webhooks/dispatch.js";

export const posts = new Hono();

// Per-route middleware chains:
//   POST /v1/posts          → API key OR dashboard session + rate limit + idempotency
//   GET  /v1/posts          → API key OR dashboard session (read-only)
//   GET  /v1/posts/:id      → same as list
//
// Both reads and writes accept the dashboard session: the dashboard's compose
// flow needs to publish without a hard-coded API key. Idempotency keys are
// scoped per organizationId (not apiKeyId), so synthetic session contexts
// replay correctly; rate-limit buckets per session id keep dashboard traffic
// in its own lane.

/**
 * API-key scope guard. Runs after apiKeyOrSession() has populated
 * c.var.apiKey, so it reads the resolved actor's grants. Dashboard sessions
 * are minted with both posts:read and posts:write (see api-key-or-session.ts),
 * so they always pass; a programmatic key missing the required scope is
 * rejected with a 403 before the handler runs.
 */
/**
 * A sandbox key may read live history but must never re-drive it: a retry or
 * reschedule of a live row ends in a real platform write, which is the one
 * thing an `lmp_test_` key must not be able to cause. 404, not 403, to match
 * the profile-scope contract.
 */
function assertKeyCanMutatePost(
  apiKey: { environment: "live" | "sandbox" },
  post: { sandbox: boolean },
): void {
  if (apiKey.environment === "sandbox" && !post.sandbox) {
    throw new LetmepostError({
      code: "not_found",
      status: 404,
      message: "Post not found.",
      rule: "api_key.environment_scope",
      remediation:
        "Live posts can only be modified with a live (`lmp_live_`) API key.",
    });
  }
}

function requireScope(scope: "posts:read" | "posts:write"): MiddlewareHandler {
  return async (c, next) => {
    if (!c.var.apiKey.scopes.includes(scope)) {
      throw new LetmepostError({
        code: "unauthorized",
        status: 403,
        message: `This API key is missing the required "${scope}" scope.`,
        rule: "api_key.scope",
        remediation: `Use an API key that includes the "${scope}" scope.`,
      });
    }
    await next();
  };
}

/**
 * Minimum future-delay before we accept a scheduled post, to avoid races
 * where the job fires before this transaction commits.
 */
const MIN_FUTURE_DELAY_MS = 1_000;

/**
 * Sandbox (`lmp_test_`) traffic is unmetered and must never move a live
 * counter: not the charge, and not the refund that mirrors it.
 */
async function chargeQuota(
  c: { var: { db: DrizzleClient; webhookDispatcher: WebhookDispatcher } },
  sandbox: boolean,
  organizationId: string,
  cost: number,
): Promise<void> {
  if (sandbox) return;
  await checkAndIncrementQuota(c.var.db, organizationId, cost, {
    webhookDispatcher: c.var.webhookDispatcher,
  });
}

async function refundQuota(
  db: DrizzleClient,
  sandbox: boolean,
  organizationId: string,
  cost: number,
): Promise<void> {
  if (sandbox) return;
  await decrementQuota(db, organizationId, cost);
}

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
 * Scheduled posts accept media: refs are persisted on `posts.mediaRefs` and
 * the worker reads them back at fire time. First-comment on scheduled posts
 * still rejects — that column doesn't exist yet and is a follow-up.
 */
posts.post(
  "/",
  apiKeyOrSession(),
  requireScope("posts:write"),
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

    const { organizationId, environment } = c.var.apiKey;
    const sandbox = environment === "sandbox";
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
        if (input.firstComment) {
          throw new LetmepostError({
            code: "validation_failed",
            status: 400,
            message:
              "Scheduled posts do not yet support firstComment — publish immediately or drop the field.",
            rule: "scheduledAt.no_first_comment",
            remediation:
              "Drop firstComment from this request, or omit scheduledAt to publish synchronously.",
          });
        }
        if (input.bluesky?.replyTo) {
          throw new LetmepostError({
            code: "validation_failed",
            status: 400,
            message:
              "Scheduled posts do not yet support Bluesky reply threading — publish immediately or drop the reply options.",
            rule: "scheduledAt.no_bluesky_reply",
            remediation:
              "Drop the bluesky `replyTo*` options from this request, or omit scheduledAt to publish the reply synchronously.",
          });
        }
      }

      // ─── Billing quota gate (scheduled) ───────────────────────────────────
      // Charged only after every request-level validation above has passed, so
      // an invalid request consumes ZERO quota. One slot per queued target —
      // accepting the batch reserves the slots; the worker owns any refund if a
      // send later fails at fire time. Idempotent replays never reach here (the
      // idempotency middleware short-circuits with the stored response), so a
      // retried key cannot double-charge. Infinity quotas (self_host,
      // grandfather, enterprise) skip the cap inside checkAndIncrementQuota.
      // Sandbox keys are unmetered and skip the gate entirely.
      await chargeQuota(c, sandbox, organizationId, resolved.length);

      const batchId = randomUUID();
      const results: PostTargetResult[] = [];
      const createdAt = new Date();
      // Targets accepted so far, so a failure partway can undo the whole
      // batch. Otherwise the caller got a 500 while earlier targets stayed
      // scheduled and still published, and a retry duplicated them.
      const accepted: Array<{
        rowId: string;
        account: DecryptedPlatformAccount;
      }> = [];

      /**
       * Cancel everything already accepted and give back the WHOLE batch's
       * quota. `checkAndIncrementQuota` charged `resolved.length` up front, so
       * refunding only the rows we managed to create would leak a slot for
       * every target after the failing one.
       */
      const unwindAccepted = async (
        errorRecord: Record<string, unknown>,
      ): Promise<void> => {
        for (const { rowId, account } of accepted) {
          await c.var.publishEnqueuer
            .remove(rowId)
            .catch((removeErr: unknown) => {
              console.error("[posts] unwind: job remove failed", removeErr);
            });
          // Guarded on still being `queued`: with a 1s minimum delay a job
          // can fire while a large batch is still unwinding, and stamping
          // `canceled` over a row that already published would be a lie.
          const canceled = await c.var.db
            .update(postsTable)
            .set({ status: "canceled", error: errorRecord })
            .where(
              and(eq(postsTable.id, rowId), eq(postsTable.status, "queued")),
            )
            .returning();
          if (canceled.length === 0) continue;
          await c.var.webhookDispatcher
            .dispatch({
              organizationId,
              type: "post.canceled",
              data: {
                id: rowId,
                platform: account.platform,
                accountId: account.id,
                profileId: account.profileId,
                scheduledAt: when.toISOString(),
                canceledAt: new Date().toISOString(),
                ...(sandbox ? { sandbox: true } : {}),
              },
              ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
            })
            .catch((dispatchErr: unknown) => {
              console.error("[posts] unwind: dispatch failed", dispatchErr);
            });
        }
        await refundQuota(c.var.db, sandbox, organizationId, resolved.length);
      };

      // Every throw inside the loop unwinds — the insert failure and the
      // `post.queued` dispatch can both blow up, and skipping the unwind on
      // those paths recreates the partial batch it exists to prevent.
      try {
      for (const { account, input } of resolved) {
        const [row] = await c.var.db
          .insert(postsTable)
          .values({
            organizationId,
            accountId: account.id,
            status: "queued",
            text: input.text,
            mediaRefs: input.media ? [...input.media] : [],
            scheduledAt: when,
            sandbox,
          })
          .returning();
        if (!row) {
          throw new LetmepostError({
            code: "internal_error",
            status: 500,
            message: "Failed to persist a scheduled post.",
          });
        }

        // The row is committed before the enqueue, so a queue failure would
        // leave a post durably `queued` with no job behind it. Undo the whole
        // batch; the reconcile sweep covers a crash before we get here.
        try {
          await c.var.publishEnqueuer.enqueue(
            {
              postId: row.id,
              organizationId,
              ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
            },
            { delayMs },
          );
        } catch (err) {
          // Mark just this row; the outer catch unwinds the rest of the batch
          // and refunds the full quota charge in one place.
          await c.var.db
            .update(postsTable)
            .set({
              status: "failed",
              error: {
                code: "internal_error",
                message:
                  "The batch could not be handed to the publish queue; no target was scheduled.",
              },
            })
            .where(eq(postsTable.id, row.id));
          console.error("[posts] publish enqueue failed", err);
          throw new LetmepostError({
            code: "internal_error",
            status: 500,
            message:
              "Could not schedule the post for delivery — the publish queue is unavailable.",
            remediation:
              "No target in this batch was scheduled. Retry the request; use an Idempotency-Key so a retry can't duplicate it.",
          });
        }
        accepted.push({ rowId: row.id, account });

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
            ...(sandbox ? { sandbox: true } : {}),
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
      } catch (err) {
        await unwindAccepted({
          code: "internal_error",
          message:
            "A later target in this batch could not be scheduled, so the whole batch was rolled back.",
          remediation:
            "Nothing was sent to any platform. Retry the request; use an Idempotency-Key so a retry can't duplicate it.",
        });
        throw err;
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

    // ─── Billing quota gate (immediate) ──────────────────────────────────────
    // Charged only after every request-level validation + preflight above has
    // passed, so an invalid request consumes ZERO quota. One slot per target is
    // reserved up front; targets that fail at publish (rejected/failed) are
    // refunded below so quota reflects only sends that actually went out.
    // Idempotent replays never reach here (the idempotency middleware
    // short-circuits with the stored response), so a retried key cannot
    // double-charge. Infinity quotas (self_host, grandfather, enterprise) skip
    // the cap inside checkAndIncrementQuota. Sandbox keys are unmetered and
    // skip the gate entirely.
    await chargeQuota(c, sandbox, organizationId, resolved.length);

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
          sandbox,
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
      { db: c.var.db, environment },
    );

    const results: PostTargetResult[] = [];
    let successCount = 0;
    let acceptedCount = 0;
    let failCount = 0;
    for (let i = 0; i < persisted.length; i++) {
      const { account, rowId } = persisted[i]!;
      const outcome = settled[i]!;
      if (outcome.status === "fulfilled") {
        const result = outcome.value;

        // TikTok publishes asynchronously (init → upload → PUBLISH →
        // status polling). The publisher returns `publishing` with the
        // publish_id stamped on `cid`; the upload is only ACCEPTED, not
        // live. Do NOT mark the row published on accept — leave it
        // `publishing`, stamp the publish_id, and enqueue the status-poll
        // job so the worker reconciles to the true terminal state
        // (published / failed / rejected) and fires the correct webhook.
        // This mirrors the scheduled path (queue/publish-processor.ts);
        // the interim `publishing` status keeps a post TikTok later fails
        // from showing as `published`.
        if (result.status === "publishing" && account.platform === "tiktok") {
          acceptedCount++;
          await c.var.db
            .update(postsTable)
            .set({ platformCid: result.cid ?? null })
            .where(eq(postsTable.id, rowId));

          await c.var.tiktokPollEnqueuer.enqueue({
            postId: rowId,
            publishId: result.cid ?? result.id,
            platformAccountId: account.id,
            organizationId,
            ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
          });

          results.push(buildPublishingResult(account, rowId, result));
          continue;
        }

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
            ...(sandbox ? { sandbox: true } : {}),
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
                ...(sandbox ? { sandbox: true } : {}),
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

    // Refund the slots reserved for targets that never published. Quota should
    // bill only sends that actually went out, so a fully-failed batch nets to
    // zero and a partial failure keeps only the successful targets charged.
    if (failCount > 0) {
      await refundQuota(c.var.db, sandbox, organizationId, failCount);
    }

    // Accepted-but-pending TikTok targets count as non-failures for the batch
    // envelope (the per-target result carries the honest `publishing` state;
    // the worker reconciles the terminal status + fires the lifecycle webhook
    // later). A batch is only "failed" when nothing published AND nothing was
    // accepted for async processing.
    const batchStatus: CreatePostResponse["status"] =
      failCount === 0
        ? "published"
        : successCount + acceptedCount === 0
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
    } else if (target.options.platform === "bluesky") {
      const o = target.options;
      if (o.replyToUri !== undefined && o.replyToCid !== undefined) {
        input.bluesky = {
          replyTo: {
            uri: o.replyToUri,
            cid: o.replyToCid,
            ...(o.replyRootUri !== undefined && o.replyRootCid !== undefined
              ? { root: { uri: o.replyRootUri, cid: o.replyRootCid } }
              : {}),
          },
        };
      }
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

/**
 * Result for an async-accepted target (TikTok): the upload was accepted but
 * TikTok has not reached a terminal state yet. Status is `publishing`; the
 * status-poll worker flips the row + fires the lifecycle webhook later. The
 * publish_id rides on `cid` so a caller can correlate with the eventual
 * post.published / post.failed event.
 */
function buildPublishingResult(
  account: DecryptedPlatformAccount,
  postId: string,
  result: PublishResult,
): PostTargetResult {
  const out: PostTargetResult = {
    accountId: account.id,
    platform: account.platform,
    postId,
    status: "publishing",
  };
  if (result.cid !== undefined) out.cid = result.cid;
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
  q: z.string().trim().min(1).max(200).optional(),
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
    sandbox: post.sandbox,
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

posts.get("/", apiKeyOrSession(), requireScope("posts:read"), async (c) => {
  const rawQuery = {
    profileId: c.req.query("profileId"),
    platform: readArrayQuery(c, "platform"),
    status: readArrayQuery(c, "status"),
    errorCode: readArrayQuery(c, "errorCode"),
    q: c.req.query("q"),
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
  if (q.q) filters.search = q.q;
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

posts.get("/:id", apiKeyOrSession(), requireScope("posts:read"), async (c) => {
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

/**
 * Every field is optional and at least one must be present, so a caller can
 * change the time, the copy, the media, or any combination, in one request.
 *
 * Omission and emptiness are deliberately different: a field left out keeps
 * its stored value, while `media: []` clears the attachments. Without that
 * distinction there is no way to express "drop the image but keep the text".
 */
const PatchPostBody = z
  .object({
    scheduledAt: z.string().datetime().optional(),
    text: z.string().min(1).optional(),
    media: z.array(MediaInput).optional(),
  })
  .refine(
    (v) =>
      v.scheduledAt !== undefined ||
      v.text !== undefined ||
      v.media !== undefined,
    { message: "Send at least one of scheduledAt, text, or media." },
  );

async function loadModifiableScheduled(
  c: {
    var: {
      db: import("../db/index.js").DrizzleClient;
      apiKey: {
        organizationId: string;
        profileId: string | null;
        environment: "live" | "sandbox";
      };
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
  assertKeyCanMutatePost(c.var.apiKey, post);
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

posts.patch("/:id", apiKeyOrSession(), requireScope("posts:write"), async (c) => {
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
  const { scheduledAt, text, media } = parsed.data;
  const editsContent = text !== undefined || media !== undefined;

  // ─── Preflight the edited content ────────────────────────────────────────
  // Run the same shape checks POST /v1/posts runs at create time, against the
  // *effective* post: a field omitted from the body keeps its stored value, so
  // swapping a 4-image set for one video is validated as the video-only post
  // it becomes. Without this an edit could park content the platform will
  // reject in the queue, where it stays valid-looking until it fires weeks
  // later — exactly the silent drip `scripts/preflight-queued.ts` exists to
  // find after the fact.
  //
  // Deep checks (byte size, MIME sniffing) still belong to publish time, same
  // as the create path: they need the resolved bytes.
  if (editsContent) {
    // preflightForAccount reads tokenMetadata for TikTok's audit-state
    // privacy rules, so this needs the decrypted account, not the public
    // summary hanging off the post row.
    const account = post.accountId
      ? await new DrizzlePlatformAccountsRepository(c.var.db).findById(
          post.accountId,
        )
      : null;
    if (!account) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 409,
        message:
          "This post's platform account was removed, so its content can't be edited.",
        rule: "post.edit.account_missing",
        remediation:
          "Cancel this post and re-create it against a connected account.",
      });
    }
    const nextMedia = (media ?? (post.mediaRefs as MediaInput[]) ?? []) as
      MediaInput[];
    preflightForAccount(account, {
      text: text ?? post.text,
      ...(nextMedia.length > 0 ? { media: nextMedia } : {}),
    });
  }

  // ─── Reschedule ─────────────────────────────────────────────────────────
  let when: Date | null = null;
  if (scheduledAt !== undefined) {
    when = new Date(scheduledAt);
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
  }

  // A content-only edit needs no queue work at all: the job carries just the
  // post id, and the worker re-reads text + mediaRefs off the row when it
  // fires.
  //
  // Conditional on the status we read. `loadModifiableScheduled` checked
  // `queued` a few statements ago, but the minimum delay is one second — a
  // job can fire in that gap, and overwriting the text of a post that has
  // already gone out would leave the row disagreeing with what the platform
  // actually published.
  const [updated] = await c.var.db
    .update(postsTable)
    .set({
      ...(when ? { scheduledAt: when } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(media !== undefined ? { mediaRefs: [...media] } : {}),
    })
    .where(and(eq(postsTable.id, post.id), eq(postsTable.status, "queued")))
    .returning();
  if (!updated) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 409,
      message:
        "This post started publishing while the edit was in flight. Nothing was changed.",
      rule: "post.status",
      remediation:
        "Re-read the post to see how it landed; use POST /v1/posts/:id/retry if it failed.",
    });
  }

  // `post.rescheduled` stays exactly what it was — a time change — so existing
  // consumers are untouched. Content edits get their own `post.updated`, and a
  // request that does both emits both: they are independent facts, and folding
  // them into one event would force consumers to diff to find out what moved.
  const eventBase = {
    id: post.id,
    platform: post.account.platform,
    accountId: post.accountId,
    profileId: post.account.profileId,
    ...(post.sandbox ? { sandbox: true } : {}),
  };
  const dispatch = (type: WebhookEventType, data: Record<string, unknown>) =>
    c.var.webhookDispatcher.dispatch({
      organizationId: post.organizationId,
      type,
      data,
      ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
    });

  if (when) {
    await dispatch("post.rescheduled", {
      ...eventBase,
      previousScheduledAt: post.scheduledAt?.toISOString(),
      scheduledAt: when.toISOString(),
    });
  }
  if (editsContent) {
    await dispatch("post.updated", {
      ...eventBase,
      changed: [
        ...(text !== undefined ? ["text"] : []),
        ...(media !== undefined ? ["media"] : []),
      ],
      scheduledAt: (when ?? post.scheduledAt)?.toISOString(),
    });
  }

  // Serialize the row the update actually wrote rather than re-deriving it
  // from the request, so the response can never claim a change the database
  // did not take.
  return c.json({
    ...publicView({ ...post, ...updated }),
  });
});

posts.delete("/:id", apiKeyOrSession(), requireScope("posts:write"), async (c) => {
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
      ...(post.sandbox ? { sandbox: true } : {}),
    },
    ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
  });

  return c.json({ id: post.id, status: "canceled" });
});

/** Statuses a post can be re-driven from. `published` is excluded so a retry
 *  can never double-post; everything else here never reached the platform. */
const RETRYABLE_STATUSES = ["failed", "rejected", "canceled"] as const;

const RetryPostBody = z.object({
  scheduledAt: z.string().datetime().optional(),
});

/**
 * `POST /v1/posts/:id/retry`
 *
 * Re-queue a post that never went out. Before this a terminal post was a dead
 * end: nothing could move it back to `queued`, so recovering from an outage or
 * an expired token meant retyping the post. That is what made the 2026-08
 * scheduler outage unrecoverable for anyone whose posts had already been
 * marked failed.
 *
 * Re-charges quota, because the failure path refunded it.
 */
posts.post("/:id/retry", apiKeyOrSession(), requireScope("posts:write"), async (c) => {
  const id = c.req.param("id");
  const { organizationId } = c.var.apiKey;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = RetryPostBody.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: issue?.message ?? "Invalid request body.",
      rule: issue?.path.join(".") || "body",
    });
  }

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
  assertKeyCanMutatePost(c.var.apiKey, post);

  if (!RETRYABLE_STATUSES.includes(post.status as (typeof RETRYABLE_STATUSES)[number])) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 409,
      message: `Cannot retry a post in status "${post.status}".`,
      rule: "post.retry.status",
      remediation: `Only ${RETRYABLE_STATUSES.join(", ")} posts can be retried.`,
    });
  }
  if (!post.accountId) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 409,
      message: "This post's platform account was removed, so it can't be retried.",
      rule: "post.retry.account_missing",
      remediation: "Re-create the post against a connected account.",
    });
  }

  // Default to firing as soon as the queue picks it up.
  const when = parsed.data.scheduledAt
    ? new Date(parsed.data.scheduledAt)
    : new Date(Date.now() + MIN_FUTURE_DELAY_MS);
  const delayMs = when.getTime() - Date.now();
  if (delayMs < MIN_FUTURE_DELAY_MS) {
    throw new LetmepostError({
      code: "validation_failed",
      status: 400,
      message: "scheduledAt must be at least 1 second in the future.",
      rule: "scheduledAt.future",
    });
  }

  // The row, not the calling key, decides metering: a sandbox post stays
  // unmetered no matter who re-drives it.
  await chargeQuota(c, post.sandbox, organizationId, 1);

  // Conditional on the status we read, so two concurrent retries can't both
  // enqueue the same post.
  const moved = await c.var.db
    .update(postsTable)
    .set({ status: "queued", scheduledAt: when, error: null })
    .where(
      and(
        eq(postsTable.id, post.id),
        inArray(postsTable.status, [...RETRYABLE_STATUSES]),
      ),
    )
    .returning();
  if (moved.length === 0) {
    await refundQuota(c.var.db, post.sandbox, organizationId, 1);
    throw new LetmepostError({
      code: "validation_failed",
      status: 409,
      message: "This post changed status before the retry could start.",
      rule: "post.retry.raced",
    });
  }

  try {
    // Clear any completed/failed job still holding the deterministic id, or
    // BullMQ dedupes the re-add against it.
    await c.var.publishEnqueuer.remove(post.id);
    await c.var.publishEnqueuer.enqueue(
      {
        postId: post.id,
        organizationId,
        ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
      },
      { delayMs },
    );
  } catch (err) {
    const errorRecord = {
      code: "internal_error",
      message: "Retry could not be handed to the publish queue.",
    };
    await c.var.db
      .update(postsTable)
      .set({ status: "failed", error: errorRecord })
      .where(eq(postsTable.id, post.id));
    await refundQuota(c.var.db, post.sandbox, organizationId, 1);
    console.error("[posts] retry enqueue failed", err);
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message: "Could not queue the retry — the publish queue is unavailable.",
      remediation: "Nothing was sent to the platform. Try again shortly.",
    });
  }

  await c.var.webhookDispatcher.dispatch({
    organizationId,
    type: "post.queued",
    data: {
      id: post.id,
      platform: post.account.platform,
      accountId: post.accountId,
      profileId: post.account.profileId,
      scheduledAt: when.toISOString(),
      queuedAt: new Date().toISOString(),
      ...(post.sandbox ? { sandbox: true } : {}),
    },
    ...(c.var.requestId ? { requestId: c.var.requestId } : {}),
  });

  return c.json({ id: post.id, status: "queued", scheduledAt: when.toISOString() });
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
    // The X launch cap. Used to fall through to `default`, marking the row
    // failed while dispatching nothing — a post that silently vanished.
    case "rate_limited":
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

