import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { auth } from "../auth.js";
import { apiKeys } from "../db/schema/api_keys.js";
import { LetmepostError } from "../errors.js";
import type { ApiKeyContext } from "./api-key.js";
import { assertTrustedOrigin } from "./origin-guard.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Auth middleware for read endpoints that should be reachable from BOTH
 * programmatic API consumers (Bearer `lmp_…` token) and the dashboard
 * (better-auth session cookie).
 *
 * On success, populates `c.var.apiKey` with a normalized actor record. For
 * session-authed callers, the synthetic `apiKey` carries `profileId: null`
 * (treated as "org-wide" — sessions don't carry a profile scope by design;
 * the caller filters by `?profileId=` if they want).
 *
 * This is read-only by intent: we don't write a real api_keys row for
 * sessions. Anything that needs a stable `apiKeyId` (e.g. audit logs,
 * idempotency replay) should not use this middleware — those are write-side
 * concerns and stay strict-API-key-auth.
 */
export function apiKeyOrSession(): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const presented = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";

    // ─── Path 1: Bearer API key (programmatic) ────────────────────────────
    if (
      presented.startsWith("lmp_live_") ||
      presented.startsWith("lmp_test_")
    ) {
      const hashed = createHash("sha256").update(presented).digest("hex");
      const [row] = await c.var.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.hashedKey, hashed), isNull(apiKeys.revokedAt)))
        .limit(1);
      if (!row) {
        throw new LetmepostError({
          code: "unauthenticated",
          status: 401,
          message: "API key is invalid or revoked.",
        });
      }
      const ctx: ApiKeyContext = {
        organizationId: row.organizationId,
        apiKeyId: row.id,
        scopes: row.scopes,
        profileId: row.profileId,
      };
      c.set("apiKey", ctx);
      // Best-effort last-used touch — don't block on it.
      void c.var.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.id))
        .catch(() => {});
      await next();
      return;
    }

    // ─── Path 2: better-auth session (dashboard) ──────────────────────────
    const result = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!result?.session || !result.user) {
      throw new LetmepostError({
        code: "unauthenticated",
        status: 401,
        message: "Authentication required.",
        remediation:
          "Send `Authorization: Bearer lmp_live_…` (programmatic) or sign in to the dashboard (cookie-based session).",
      });
    }
    const orgId = result.session.activeOrganizationId;
    if (!orgId) {
      throw new LetmepostError({
        code: "unauthorized",
        status: 403,
        message: "No active organization on this session.",
        remediation:
          "Switch to an organization in the dashboard before viewing posts.",
      });
    }

    const synthetic: ApiKeyContext = {
      organizationId: orgId,
      // The literal "session" prefix flags downstream code that this isn't a
      // real key id — useful in audit logs that want to distinguish surfaces.
      apiKeyId: `session:${result.session.id}`,
      scopes: ["posts:read", "posts:write"],
      // Session = org-wide read. Profile filtering is via ?profileId only.
      profileId: null,
    };
    c.set("apiKey", synthetic);
    c.set("session", { userId: result.user.id, organizationId: orgId });

    // CSRF gate — session-cookie path only. In production the cookie is
    // SameSite=None, so the browser attaches it to cross-site credentialed
    // mutations; without this a text/plain (preflight-free) POST from any
    // site could publish on a logged-in user's behalf. Bearer-key clients
    // (Path 1 above) legitimately send no Origin and returned earlier, so
    // they never reach this. Reads stay open.
    if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
      assertTrustedOrigin(c);
    }

    await next();
  };
}
