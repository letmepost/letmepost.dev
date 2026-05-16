import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { idempotencyRecords } from "../db/schema/idempotency_records.js";
import { LetmepostError } from "../errors.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 255;

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

/**
 * Idempotency-Key replay middleware. Opt-in: if the caller doesn't send
 * `Idempotency-Key`, the request passes through unchanged.
 *
 * On hit within the 24h window:
 *   - matching body hash → the stored response is replayed verbatim.
 *   - different body hash → 409 idempotency_conflict.
 *
 * On miss, we run the handler, then persist the response for future replays.
 * We only store 2xx and 4xx responses — 5xx should be retried, not replayed.
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
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

    if (existing) {
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
    }

    await next();

    const status = c.res.status;
    if (status >= 500) return;

    let parsed: unknown = null;
    try {
      const text = await c.res.clone().text();
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // Non-JSON response — skip storage rather than persist an opaque blob.
      return;
    }

    try {
      await db.insert(idempotencyRecords).values({
        organizationId,
        key,
        requestHash,
        responseBody: parsed,
        statusCode: status,
      });
      c.header("Idempotency-Key", key);
    } catch {
      // Lost an insert race with a concurrent duplicate — the first request
      // already persisted its own response, which is close enough. Swallow.
    }
  };
}
