// Admin impersonation, in two halves.
//
//   POST /admin/impersonation/mint     — server-to-server, called by the
//     internal admin dashboard with the shared ADMIN_IMPERSONATION_SECRET.
//     Records a grant and returns a short-lived opaque token.
//   GET  /admin/impersonation/consume  — opened in the operator's browser.
//     Redeems the token, starts a session for the target user, and redirects
//     into the dashboard.
//
// The split exists so the secret never travels to a browser: minting is a
// back-channel call, and the thing that reaches the front channel is a
// single-use token that dies in two minutes.
//
// Why a better-auth plugin rather than a plain Hono route: session creation and
// cookie signing have to go through better-auth's own internals
// (`internalAdapter.createSession` + `setSessionCookie`), exactly as the
// magic-link plugin does. Hand-rolling the session cookie would mean
// duplicating its signing format.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { db } from "../db/instance.js";
import { impersonationGrants } from "../db/schema/impersonation.js";


/** How long a minted token stays redeemable. Deliberately tiny. */
const TOKEN_TTL_MS = 120_000;

/**
 * Lifetime of the resulting session. Impersonation is for looking at a bug, not
 * for living in someone's account, so it expires far sooner than a real login.
 */
const SESSION_TTL_MS = 60 * 60 * 1000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time compare that also tolerates length mismatch. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(sha256(provided), "hex");
  const b = Buffer.from(sha256(expected), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function clientIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() ?? null;
  return headers.get("x-real-ip");
}

const mintBody = z.object({
  userId: z.string().uuid(),
  /**
   * Operator label recorded on the grant. Required so the audit row is never
   * anonymous — the shared admin key cannot tell us who is behind it.
   */
  actor: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
});

export function adminImpersonation(dashboardUrl: string): BetterAuthPlugin {
  return {
    id: "admin-impersonation",
    endpoints: {
      mintImpersonationToken: createAuthEndpoint(
        "/admin/impersonation/mint",
        { method: "POST", body: mintBody },
        async (ctx) => {
          const configured = process.env.ADMIN_IMPERSONATION_SECRET;
          // Fail closed: with no secret set, the endpoint is unusable rather
          // than open.
          if (!configured || configured.length < 32) {
            throw new APIError("NOT_FOUND", {
              message: "Impersonation is not enabled on this deployment.",
            });
          }
          const presented = ctx.headers?.get("x-admin-secret") ?? "";
          if (!presented || !secretMatches(presented, configured)) {
            throw new APIError("UNAUTHORIZED", {
              message: "Invalid admin secret.",
            });
          }

          const { userId, actor, reason } = ctx.body;
          const target = await ctx.context.internalAdapter.findUserById(userId);
          if (!target) {
            throw new APIError("NOT_FOUND", { message: "User not found." });
          }

          const token = randomBytes(32).toString("base64url");
          const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
          await db.insert(impersonationGrants).values({
            tokenHash: sha256(token),
            targetUserId: userId,
            actor,
            reason: reason ?? null,
            requestedIp: clientIp(ctx.headers ?? new Headers()),
            requestedUserAgent: ctx.headers?.get("user-agent") ?? null,
            expiresAt,
          });

          return ctx.json({
            consumeUrl: `${ctx.context.baseURL}/admin/impersonation/consume?token=${token}`,
            expiresAt: expiresAt.toISOString(),
            target: { id: target.id, email: target.email },
          });
        },
      ),

      consumeImpersonationToken: createAuthEndpoint(
        "/admin/impersonation/consume",
        { method: "GET", query: z.object({ token: z.string().min(1) }) },
        async (ctx) => {
          const tokenHash = sha256(ctx.query.token);

          // Claim the grant atomically. Guarding on `used_at IS NULL` in the
          // UPDATE (rather than checking then writing) is what makes the token
          // genuinely single-use under concurrent redemption.
          const [grant] = await db
            .update(impersonationGrants)
            .set({ usedAt: new Date(), consumedIp: clientIp(ctx.headers ?? new Headers()) })
            .where(
              and(
                eq(impersonationGrants.tokenHash, tokenHash),
                isNull(impersonationGrants.usedAt),
              ),
            )
            .returning();

          if (!grant) {
            throw new APIError("UNAUTHORIZED", {
              message: "This impersonation link is invalid or already used.",
            });
          }
          if (grant.expiresAt.getTime() < Date.now()) {
            throw new APIError("UNAUTHORIZED", {
              message: "This impersonation link has expired.",
            });
          }

          const target = await ctx.context.internalAdapter.findUserById(
            grant.targetUserId,
          );
          if (!target) {
            throw new APIError("NOT_FOUND", { message: "User not found." });
          }

          // `impersonatedBy` marks the session and the short `expiresAt` caps
          // it: impersonation is for looking at a bug, not for living in
          // someone's account. Both are set at creation rather than patched
          // after, so no window exists where the session looks like a normal
          // login with a normal expiry. dontRememberMe=true keeps it out of the
          // "remember me" long-lived path.
          const session = await ctx.context.internalAdapter.createSession(
            target.id,
            true,
            {
              impersonatedBy: grant.actor,
              expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
          );
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Could not create the impersonation session.",
            });
          }

          await db
            .update(impersonationGrants)
            .set({ sessionId: session.id })
            .where(eq(impersonationGrants.id, grant.id));

          await setSessionCookie(ctx, { session, user: target });

          throw ctx.redirect(dashboardUrl);
        },
      ),
    },
  };
}
