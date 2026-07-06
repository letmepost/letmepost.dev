import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { DrizzleClient } from "../db/index.js";
import { idempotencyRecords } from "../db/schema/idempotency_records.js";
import { LetmepostError } from "../errors.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 255;

// `statusCode = 0` marks an in-flight claim (no real HTTP status is < 100).
const PENDING_STATUS = 0;
// A pending claim older than this is treated as abandoned and may be taken
// over — bounds how long a crashed request can block a retry of the same key.
const PENDING_TTL_MS = 60 * 1000;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hashBody(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function getOrgId(c: Context): string | null {
  const fromKey = (c.get("apiKey") as { organizationId?: string } | undefined)?.organizationId;
  if (fromKey) return fromKey;
  const fromSession = (c.get("session") as { organizationId?: string } | undefined)?.organizationId;
  if (fromSession) return fromSession;
  return null;
}

function inProgressError(): LetmepostError {
  return new LetmepostError({
    code: "idempotency_conflict",
    status: 409,
    message: "A request with this Idempotency-Key is already in progress.",
    rule: "idempotency_key.in_progress",
    remediation:
      "Wait for the original request to complete, then retry with the same Idempotency-Key.",
  });
}

/**
 * Drop our in-flight claim so a later retry can execute. Scoped to the pending
 * sentinel (statusCode 0) so we can never delete a completed row.
 */
async function releaseClaim(
  db: DrizzleClient,
  organizationId: string,
  key: string,
): Promise<void> {
  await db
    .delete(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.key, key),
        eq(idempotencyRecords.statusCode, PENDING_STATUS),
      ),
    );
}

/**
 * We hold the claim: run the handler, then persist its response into the
 * pending sentinel (2xx/4xx) or release the claim (5xx / non-JSON) so those
 * stay retryable.
 */
async function runAndPersist(
  c: Context,
  next: Next,
  claim: { db: DrizzleClient; organizationId: string; key: string },
): Promise<void> {
  const { db, organizationId, key } = claim;

  try {
    await next();
  } catch (err) {
    await releaseClaim(db, organizationId, key);
    throw err;
  }

  const status = c.res.status;
  if (status >= 500) {
    await releaseClaim(db, organizationId, key);
    return;
  }

  let parsed: unknown = null;
  try {
    const text = await c.res.clone().text();
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response — release the claim rather than persist an opaque blob.
    await releaseClaim(db, organizationId, key);
    return;
  }

  await db
    .update(idempotencyRecords)
    .set({ responseBody: parsed, statusCode: status })
    .where(
      and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.key, key),
        eq(idempotencyRecords.statusCode, PENDING_STATUS),
      ),
    );
  c.header("Idempotency-Key", key);
}

/**
 * Idempotency-Key replay middleware. Opt-in: if the caller doesn't send
 * `Idempotency-Key`, the request passes through unchanged.
 *
 * Concurrency-safe via insert-pending-first: a request first claims the key by
 * inserting an in-flight sentinel row (statusCode 0), serialized on the
 * (organizationId, key) unique index. Exactly one of a set of concurrent
 * duplicates wins the claim and runs the handler; the losers observe the
 * existing row instead of re-executing — so a retried key can never
 * double-publish or double-consume quota (the unique index alone only prevents
 * duplicate STORAGE, not duplicate EXECUTION).
 *
 * When a request finds an existing row (within the 24h window):
 *   - in-flight (pending) → 409 idempotency_conflict (in_progress). A pending
 *     row older than PENDING_TTL_MS is treated as abandoned and taken over.
 *   - completed + matching body hash → the stored response is replayed verbatim.
 *   - completed + different body hash → 409 idempotency_conflict (body_mismatch).
 *
 * The claimant persists its response into the sentinel row on completion. We
 * only store 2xx and 4xx — 5xx releases the claim so it is retried, not replayed.
 *
 * Must run after auth middleware so we can scope records per organization.
 *
 * Batch semantics (multi-target /v1/posts): the key is applied to the WHOLE
 * batch body. Replaying a retried fan-out request returns the original
 * CreatePostResponse — same batch id, same per-target results — rather than
 * re-publishing. Body-hash inclusion of `targets[]` means a retry that
 * mutates even one target re-keys as a conflict, which is the correct
 * fail-loud signal: changing targets mid-retry is almost always a bug.
 */
export function idempotency(): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITE_METHODS.has(c.req.method)) return next();
    const key = c.req.header("Idempotency-Key");
    if (!key) return next();
    if (key.length > MAX_KEY_LENGTH) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: `Idempotency-Key must be ${MAX_KEY_LENGTH} characters or fewer.`,
        rule: "idempotency_key.length",
      });
    }

    const organizationId = getOrgId(c);
    if (!organizationId) return next();

    const rawBody = await c.req.raw.clone().text();
    const requestHash = hashBody(rawBody);

    const db = c.var.db;

    // Claim the key: insert an in-flight sentinel. Under a concurrent duplicate
    // exactly one INSERT returns a row; the loser's unique-violation is turned
    // into a no-op by onConflictDoNothing and handled via the existing row.
    const [claimed] = await db
      .insert(idempotencyRecords)
      .values({
        organizationId,
        key,
        requestHash,
        responseBody: null,
        statusCode: PENDING_STATUS,
        // Explicit (ms precision) rather than defaultNow() so the stale-takeover
        // guard below can pin the exact row via `created_at = …` equality.
        createdAt: new Date(),
      })
      .onConflictDoNothing({
        target: [idempotencyRecords.organizationId, idempotencyRecords.key],
      })
      .returning();

    if (claimed) {
      return runAndPersist(c, next, { db, organizationId, key });
    }

    // A row already exists for (org, key). Load it within the replay window.
    const cutoff = new Date(Date.now() - WINDOW_MS);
    const [existing] = await db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.organizationId, organizationId),
          eq(idempotencyRecords.key, key),
          gt(idempotencyRecords.createdAt, cutoff),
        ),
      )
      .limit(1);

    if (!existing) {
      // The conflicting row is older than the window (expired). Preserve prior
      // behavior: re-execute without replaying a stale response.
      return next();
    }

    if (existing.statusCode === PENDING_STATUS) {
      const isStale = existing.createdAt.getTime() < Date.now() - PENDING_TTL_MS;
      if (!isStale) {
        throw inProgressError();
      }
      // The in-flight request looks abandoned. Take over the claim, guarding
      // against a racing takeover by pinning the exact stale row.
      const [tookOver] = await db
        .update(idempotencyRecords)
        .set({ requestHash, createdAt: new Date() })
        .where(
          and(
            eq(idempotencyRecords.organizationId, organizationId),
            eq(idempotencyRecords.key, key),
            eq(idempotencyRecords.statusCode, PENDING_STATUS),
            eq(idempotencyRecords.createdAt, existing.createdAt),
          ),
        )
        .returning();
      if (!tookOver) {
        throw inProgressError();
      }
      return runAndPersist(c, next, { db, organizationId, key });
    }

    // Completed row within the window: replay on hash match, else conflict.
    if (existing.requestHash !== requestHash) {
      throw new LetmepostError({
        code: "idempotency_conflict",
        status: 409,
        message: "Idempotency-Key reused with a different request body.",
        rule: "idempotency_key.body_mismatch",
        remediation:
          "Either retry with the original request body, or generate a new Idempotency-Key for a different request.",
      });
    }
    c.header("Idempotency-Replayed", "true");
    c.header("Idempotency-Key", key);
    return c.json(
      existing.responseBody,
      existing.statusCode as Parameters<Context["json"]>[1],
    );
  };
}
