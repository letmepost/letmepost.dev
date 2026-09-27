import { Hono } from "hono";
import { docsBase } from "../errors.js";

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
  const origin = new URL(c.req.url).origin;
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
