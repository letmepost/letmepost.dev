import { Hono, type Context } from "hono";
import { docsBase } from "../errors.js";

/** First hop of a possibly comma-chained forwarded header. */
function firstHop(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

/** `http` / `https` only — anything else is a malformed or hostile header. */
function validProto(value: string | undefined): string | undefined {
  return value === "http" || value === "https" ? value : undefined;
}

/** host[:port], no scheme, path, spaces or credentials. */
function validHost(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(value)
    ? value
    : undefined;
}

/**
 * Public origin to advertise in the index, in order of trust:
 *
 *  1. `BETTER_AUTH_URL` — the configured public origin. Already required in
 *     production and already the authority behind the `.well-known`
 *     discovery documents, so sourcing it here keeps the OAuth link in this
 *     index consistent with what those documents declare.
 *  2. `X-Forwarded-Proto` / `X-Forwarded-Host` — for deployments that leave
 *     the env unset. Taken as a pair: a forwarded proto combined with the
 *     internal request host would advertise `https://internal:3000`, so
 *     unless both are present and well-formed, neither is used.
 *  3. The request URL — local dev, where no proxy is in front.
 *
 * TLS terminates at the platform proxy, so the request URL alone is plain
 * `http://` with the internal host; advertising it verbatim handed callers
 * `http://` links to an HTTPS-only API.
 */
function publicOrigin(c: Context): string {
  const configured = process.env.BETTER_AUTH_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Malformed env — fall through rather than emit a broken origin.
    }
  }

  const proto = validProto(firstHop(c.req.header("x-forwarded-proto")));
  const host = validHost(firstHop(c.req.header("x-forwarded-host")));
  if (proto && host) return `${proto}://${host}`;

  return new URL(c.req.url).origin;
}

/**
 * Service index for the bare API origin. `GET https://api.letmepost.dev/`
 * used to fall through to Hono's plain-text 404, which is a bad first
 * impression for anyone — human or agent — who trims the path off an
 * endpoint to see what this host is.
 *
 * Deliberately unauthenticated and free of per-org data: it advertises
 * where the docs, spec, and dashboard live, nothing more. Self-referencing
 * links are derived from the request origin so staging and local dev
 * describe themselves rather than production.
 */
export const root = new Hono();

root.get("/", (c) => {
  const origin = publicOrigin(c);
  const docs = docsBase();

  return c.json({
    name: "letmepost.dev",
    description:
      "Social media publishing API. One POST fans out to eight platforms, with preflight validation, transparent errors, and idempotency by default.",
    version: "v1",
    status: "ok",
    documentation: {
      docs,
      quickstart: `${docs}/quickstart`,
      apiReference: `${docs}/api-reference`,
      openapi: `${docs}/api-reference/openapi.json`,
      errors: `${docs}/errors`,
    },
    // URLs only. Auth varies by operation, not by path — GET /v1/accounts
    // takes a Bearer key while DELETE /v1/accounts/:id is dashboard-session
    // only — and the OpenAPI spec already encodes that per operation via
    // `security`. Restating it here would be a second source of truth that
    // silently rots, so callers are pointed at the spec instead.
    endpoints: {
      posts: `${origin}/v1/posts`,
      media: `${origin}/v1/media`,
      accounts: `${origin}/v1/accounts`,
      profiles: `${origin}/v1/profiles`,
      webhookEndpoints: `${origin}/v1/webhook-endpoints`,
      apiKeys: `${origin}/v1/api-keys`,
      billing: `${origin}/v1/billing`,
      mcp: `${origin}/mcp`,
      health: `${origin}/health`,
    },
    authentication: {
      apiKey: {
        scheme: "Bearer",
        header: "Authorization: Bearer lmp_live_…",
        mint: "https://dashboard.letmepost.dev",
      },
      session: {
        description:
          "better-auth session cookie. Org-management operations (connecting or disconnecting an account, profiles, API keys, billing) are dashboard-only.",
        dashboard: "https://dashboard.letmepost.dev",
      },
      oauth: {
        description:
          "OAuth 2.1 with Dynamic Client Registration, for MCP clients. The resource identifier is /mcp, so discovery is the /mcp-suffixed document per RFC 9728.",
        discovery: `${origin}/.well-known/oauth-protected-resource/mcp`,
      },
      // Deliberately points at the prose docs, not the OpenAPI spec: the spec
      // only models the Bearer scheme, so it marks dashboard-session-only
      // operations as `security: []`, which a spec reader would take to mean
      // "public" rather than "session required".
      docs: `${docs}/authentication`,
    },
    source: "https://github.com/letmepost/letmepost.dev",
  });
});
