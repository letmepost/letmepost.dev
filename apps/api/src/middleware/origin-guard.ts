import type { MiddlewareHandler } from "hono";
import { LetmepostError } from "../errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function loadTrustedOrigins(): Set<string> {
  const fromEnv = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(["http://localhost:3001", ...fromEnv]);
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

    const origin = c.req.header("Origin") ?? null;
    const referer = c.req.header("Referer") ?? null;
    let source = origin;
    if (!source && referer) {
      try {
        source = new URL(referer).origin;
      } catch {
        source = null;
      }
    }

    if (!source) {
      throw new LetmepostError({
        code: "unauthorized",
        status: 403,
        message: "Missing Origin or Referer on cross-origin mutation.",
      });
    }

    const trusted = loadTrustedOrigins();
    if (!trusted.has(source)) {
      throw new LetmepostError({
        code: "unauthorized",
        status: 403,
        message: "Request origin is not trusted.",
      });
    }

    await next();
  };
}
