import type { Context, MiddlewareHandler } from "hono";
import { LetmepostError } from "../errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Origins we accept on credentialed cross-site mutations. Mirrors the list
// better-auth trusts for its own routes: the dashboard (DASHBOARD_URL, or
// localhost:3001 in dev) plus anything in TRUSTED_ORIGINS. Recomputed per call
// so tests / deploys that flip the env vars are picked up without a restart.
function loadTrustedOrigins(): Set<string> {
  const fromEnv = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const dashboard = process.env.DASHBOARD_URL ?? "http://localhost:3001";
  return new Set([dashboard, "http://localhost:3001", ...fromEnv]);
}

// Resolve the site the request came from: Origin header first, Referer's
// origin as a fallback. Returns null when neither is present or parseable.
function requestSource(c: Context): string | null {
  const origin = c.req.header("Origin") ?? null;
  if (origin) return origin;
  const referer = c.req.header("Referer") ?? null;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/** True when `origin` is a non-null, trusted origin. */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return loadTrustedOrigins().has(origin);
}

// CSRF gate for a single request. Throws 403 when the Origin/Referer is
// missing or not trusted. Shared by originGuard() and the session-cookie
// branch of apiKeyOrSession() so both surfaces reject identically.
export function assertTrustedOrigin(c: Context): void {
  const source = requestSource(c);
  if (!source) {
    throw new LetmepostError({
      code: "unauthorized",
      status: 403,
      message: "Missing Origin or Referer on cross-origin mutation.",
    });
  }
  if (!isAllowedOrigin(source)) {
    throw new LetmepostError({
      code: "unauthorized",
      status: 403,
      message: "Request origin is not trusted.",
    });
  }
}

// CSRF defense for session-authenticated mutating routes. In production the
// session cookie is SameSite=None (it has to cross-subdomain from dashboard
// to api), so the browser will attach it to credentialed cross-origin POSTs.
// We compare Origin (Referer as fallback) against the same trusted list
// better-auth uses for its own routes and reject mismatches.
export function originGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    assertTrustedOrigin(c);
    await next();
  };
}
