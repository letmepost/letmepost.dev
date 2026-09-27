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
    // Each entry states its own auth requirement. Not every surface takes an
    // API key: the org-management routes are dashboard-session only, so a
    // flat "use Bearer" hint here would send callers into a 401.
    endpoints: {
      posts: { url: `${origin}/v1/posts`, auth: "api_key_or_session" },
      media: { url: `${origin}/v1/media`, auth: "api_key_or_session" },
      webhookEndpoints: {
        url: `${origin}/v1/webhook-endpoints`,
        auth: "api_key_or_session",
      },
      mcp: { url: `${origin}/mcp`, auth: "api_key" },
      accounts: { url: `${origin}/v1/accounts`, auth: "session" },
      profiles: { url: `${origin}/v1/profiles`, auth: "session" },
      apiKeys: { url: `${origin}/v1/api-keys`, auth: "session" },
      billing: { url: `${origin}/v1/billing`, auth: "session" },
      health: { url: `${origin}/health`, auth: "none" },
    },
    authentication: {
      api_key: {
        scheme: "Bearer",
        header: "Authorization: Bearer lmp_live_…",
        mint: "https://dashboard.letmepost.dev",
      },
      session: {
        description:
          "better-auth session cookie. Org-management endpoints are dashboard-only and do not accept API keys.",
        dashboard: "https://dashboard.letmepost.dev",
      },
      docs: `${docs}/authentication`,
    },
    source: "https://github.com/letmepost/letmepost.dev",
  });
});
