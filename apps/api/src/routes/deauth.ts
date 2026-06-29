import { and, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { platformAccounts } from "../db/schema/index.js";
import {
  META_SIGNED_REQUEST_MAX_AGE_MS,
  parseMetaSignedRequest,
} from "../webhooks/meta-signed-request.js";

/**
 * Meta deauthorize callback. Meta pings this when a user removes the app
 * from their account (Settings → Apps → Remove). Unlike data-deletion,
 * Meta does not expect a `{url, confirmation_code}` response — a 200
 * status is the entire contract.
 *
 *   POST /deauth/meta
 *   body: application/x-www-form-urlencoded with `signed_request=<…>`
 *   auth: the signed_request itself (HMAC-SHA256 keyed with META_APP_SECRET)
 *
 * Cleanup parity with /data-deletion/meta: every platform_account row in
 * the Meta product family (facebook, instagram, threads) belonging to the
 * connecting Meta user is removed. The match is on the app-scoped user id
 * persisted in tokenMetadata (`metaUserId` for facebook/instagram, `userId`
 * for threads) — NOT platformAccountId, which holds the Page/IG/Threads id.
 * Posts + post_attempts cascade.
 */

const META_PLATFORMS = ["facebook", "instagram", "threads"] as const;

export const deauth = new Hono();

deauth.post("/meta", async (c) => {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    // 503 so Meta retries with backoff and the misconfiguration shows up
    // in logs instead of silently confirming a no-op deauth.
    return c.json({ error: "deauth_callback_not_configured" }, 503);
  }

  let signedRequest: string | null = null;
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

  const payload = parseMetaSignedRequest(signedRequest, appSecret, {
    maxAgeMs: META_SIGNED_REQUEST_MAX_AGE_MS,
  });
  if (!payload) {
    return c.json({ error: "signed_request_invalid" }, 400);
  }

  const removed = await c.var.db
    .delete(platformAccounts)
    .where(
      and(
        inArray(platformAccounts.platform, META_PLATFORMS),
        sql`(${platformAccounts.tokenMetadata} ->> 'metaUserId' = ${payload.user_id} OR ${platformAccounts.tokenMetadata} ->> 'userId' = ${payload.user_id})`,
      ),
    )
    .returning();

  console.log(
    `[deauth/meta] user_id=${payload.user_id} removed=${removed.length}`,
  );

  return c.body(null, 200);
});
