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
    endpoints: {
      posts: `${origin}/v1/posts`,
      media: `${origin}/v1/media`,
      accounts: `${origin}/v1/accounts`,
      profiles: `${origin}/v1/profiles`,
      webhookEndpoints: `${origin}/v1/webhook-endpoints`,
      apiKeys: `${origin}/v1/api-keys`,
      mcp: `${origin}/mcp`,
      health: `${origin}/health`,
    },
    authentication: {
      scheme: "Bearer",
      header: "Authorization: Bearer lmp_live_…",
      dashboard: "https://dashboard.letmepost.dev",
      docs: `${docs}/authentication`,
    },
    source: "https://github.com/letmepost/letmepost.dev",
  });
});
