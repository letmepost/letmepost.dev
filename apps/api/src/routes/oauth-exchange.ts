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
    // `lmp login` exists so the CLI and MCP server can publish. Minting the key
    // with no scopes made every CLI login unable to reach POST /v1/posts, which
    // requires posts:write.
    scopes: ["posts:read", "posts:write"],
  });

  return c.json({
    key: plaintext,
    organizationId,
  });
});
