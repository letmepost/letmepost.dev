import { randomUUID } from "node:crypto";
import { and, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { platformAccounts } from "../db/schema/index.js";
import { parseMetaSignedRequest } from "../webhooks/meta-signed-request.js";

/**
 * Public, unauthenticated callback endpoint Meta calls when a user requests
 * deletion of their data via Facebook's "Apps and Websites" settings.
 *
 *   POST /data-deletion/meta
 *
 * Body:  application/x-www-form-urlencoded with `signed_request=<…>`
 * Auth:  the signed_request itself — HMAC-SHA256 over the encoded payload
 *        keyed with META_APP_SECRET. No bearer token, no session.
 *
 * Response shape Meta expects (any 200 with this exact JSON shape is OK):
 *   {
 *     "url": "<status page URL where the user can verify deletion>",
 *     "confirmation_code": "<opaque tracking code>"
 *   }
 *
 * The status page is mounted at GET /data-deletion/status?code=<…>.
 */

const META_PLATFORMS = ["facebook", "instagram", "threads"] as const;

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export const dataDeletion = new Hono();

dataDeletion.post("/meta", async (c) => {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    // Misconfiguration. Return 503 so Meta retries with backoff and we notice
    // in the logs rather than silently confirming a deletion that didn't run.
    return c.json(
      { error: "data_deletion_callback_not_configured" },
      503,
    );
  }

  let signedRequest: string | null = null;

  // Meta sends application/x-www-form-urlencoded; some integrations also send
  // JSON in test fixtures. Accept both rather than 400ing on content-type.
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await c.req.json()) as { signed_request?: unknown };
      if (typeof body?.signed_request === "string") {
        signedRequest = body.signed_request;
      }
    } catch {
      // fallthrough
    }
  } else {
    try {
      const form = await c.req.formData();
      const v = form.get("signed_request");
      if (typeof v === "string") signedRequest = v;
    } catch {
      // fallthrough
    }
  }

  if (!signedRequest) {
    return c.json({ error: "signed_request_missing" }, 400);
  }

  const payload = parseMetaSignedRequest(signedRequest, appSecret);
  if (!payload) {
    return c.json({ error: "signed_request_invalid" }, 400);
  }

  const db = c.var.db;
  const confirmationCode = `lmp_${randomUUID()}`;

  // Delete every platform_account row for the Meta product family that maps
  // to this app-scoped user_id. The match is on tokenMetadata.metaUserId —
  // NOT platformAccountId — because for the Meta family platformAccountId
  // holds a per-product resource id (FB Page id / IG user id / Threads user
  // id), none of which equals the app-scoped user_id Meta sends here. The
  // app-scoped id is captured at connect time by each provider's
  // completeConnect. Posts and post_attempts cascade via the schema's
  // onDelete setup, so we don't need to touch them by hand here. If no rows
  // match (user never connected, or already disconnected) we still return
  // 200 — Meta's contract doesn't differentiate, and from the user's
  // perspective "no data to delete" is a successful deletion.
  const removed = await db
    .delete(platformAccounts)
    .where(
      and(
        inArray(platformAccounts.platform, META_PLATFORMS),
        sql`${platformAccounts.tokenMetadata} ->> 'metaUserId' = ${payload.user_id}`,
      ),
    )
    .returning();

  console.log(
    `[data-deletion/meta] user_id=${payload.user_id} removed=${removed.length} code=${confirmationCode}`,
  );

  const baseUrl =
    process.env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
    "https://api.letmepost.dev";

  return c.json({
    url: `${baseUrl}/data-deletion/status?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
});

dataDeletion.get("/status", (c) => {
  const code = c.req.query("code") ?? "";
  const safeCode = htmlEscape(code).slice(0, 200);
  return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Data deletion status — letmepost.dev</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #111; line-height: 1.55; }
      h1 { font-size: 1.5rem; margin-bottom: 1rem; }
      code { background: #f4f4f5; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
      a { color: #0a7; }
    </style>
  </head>
  <body>
    <h1>Data deletion request</h1>
    <p>If this request originated from Meta's "Apps and Websites" settings,
    the platform account it referenced has been disconnected from
    letmepost.dev and its OAuth tokens removed.</p>
    ${safeCode ? `<p>Confirmation code: <code>${safeCode}</code></p>` : ""}
    <p>For questions or to delete your full letmepost.dev account, email
    <a href="mailto:support@letmepost.dev">support@letmepost.dev</a>.</p>
  </body>
</html>`);
});
