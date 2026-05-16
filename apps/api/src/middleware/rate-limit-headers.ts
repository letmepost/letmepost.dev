import type { MiddlewareHandler } from "hono";

/**
 * Surface the per-route rate-limit ceiling on every response so clients can
 * write conservative back-off without first probing a 429.
 *
 * We publish ONLY `X-RateLimit-Limit` for v1 — a static per-route cap, no
 * counter, no reset timestamp. Until per-key counting is real (Redis-backed,
 * sliding window per api key + per route), publishing `Remaining` and
 * `Reset` would be worse than not publishing them: a single in-memory map
 * shared across tenants and processes can't honestly answer "how many
 * requests does THIS api key have left." Clients honoring the headers would
 * throttle themselves on another tenant's burst.
 *
 * The per-route enforcement middleware keeps its own `RateLimit-*` (IETF
 * draft, no prefix) headers — clients should prefer those when present;
 * they reflect the real sliding-window state for that route.
 */

const RATE_LIMITS: Record<string, number> = {
  "POST /v1/posts": 1000,
  "POST /v1/media": 500,
  default: 5000,
};

function limitFor(method: string, path: string): number {
  const exact = `${method} ${path}`;
  return RATE_LIMITS[exact] ?? RATE_LIMITS.default!;
}

export function rateLimitHeaders(): MiddlewareHandler {
  return async (c, next) => {
    c.header("X-RateLimit-Limit", String(limitFor(c.req.method, c.req.path)));
    await next();
  };
}
