// Exchange an OAuth bearer access token for a freshly-minted API key. Used
// by the CLI's `lmp login` flow: after the browser PKCE handshake the CLI
// has a JWT but the rest of the API expects a `lmp_live_...` Bearer. This
// endpoint trades the JWT for a key so the CLI can store one credential
// that works against the entire /v1/* surface without further plumbing.
//
// Auth: oauthBearer() — the caller proves they hold a valid OAuth access
// token. The endpoint resolves the user's primary org membership and mints
// a per-user key bound to that org. Cross-org operation requires the
// caller to switch active org before calling this endpoint.

import { createHash, randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { apiKeys } from "../db/schema/api_keys.js";
import { member } from "../db/schema/auth.js";
import { LetmepostError } from "../errors.js";
import { oauthBearer } from "../middleware/oauth-bearer.js";

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generateKey(prefix: "lmp_live_" | "lmp_test_"): string {
  const secret = randomBytes(24).toString("base64url");
  return `${prefix}${secret}`;
}

export const oauthExchange = new Hono();

oauthExchange.post("/", oauthBearer(), async (c) => {
  // oauthBearer() guarantees this is set on success; if it weren't, the
  // middleware would have thrown 401 before reaching here.
  const oauth = c.get("oauth");
  if (!oauth) {
    throw new LetmepostError({
      code: "unauthenticated",
      status: 401,
      message: "OAuth context missing after middleware.",
    });
  }
  const { userId } = oauth;
  const db = c.var.db;

  // Mirror the token's consent grant rather than hardcoding publish rights:
  // dynamic client registration is open (see auth.ts), so a client holding
  // only `read` consent must not walk away with a key that can post.
  const keyScopes = oauth.scopes.includes("publish")
    ? ["posts:read", "posts:write"]
    : oauth.scopes.includes("read")
      ? ["posts:read"]
      : [];

  // Fail loudly rather than hand back a key that 403s on first use.
  if (keyScopes.length === 0) {
    throw new LetmepostError({
      code: "unauthorized",
      status: 403,
      rule: "oauth.insufficient_scope",
      message:
        "This OAuth token grants neither the `publish` nor the `read` scope, so the minted key could not access any posts endpoint.",
      remediation:
        "Re-authorize requesting the `publish` scope (or `read` for a read-only key), then retry.",
    });
  }

  // Pick the user's primary organization membership (oldest first). Active
  // org switching lives on the better-auth session, which the OAuth token
  // doesn't carry — for now we always mint under the primary org.
  const [m] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt))
    .limit(1);
  const organizationId = m?.organizationId ?? null;

  if (!organizationId) {
    throw new LetmepostError({
      code: "not_found",
      status: 404,
      rule: "user.no_organization",
      message: "Authenticated user is not a member of any organization.",
      remediation:
        "Sign in to the dashboard and create or join an organization, then re-run `lmp login`.",
    });
  }

  const plaintext = generateKey("lmp_live_");
  const last4 = plaintext.slice(-4);

  await db.insert(apiKeys).values({
    organizationId,
    profileId: null,
    name: "letmepost-cli",
    prefix: "lmp_live_",
    hashedKey: hashKey(plaintext),
    last4,
    scopes: keyScopes,
  });

  return c.json({
    key: plaintext,
    organizationId,
  });
});
