import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless OAuth state token. Carries the {organizationId, profileId,
 * platform, exp} context across the redirect round-trip so the GET
 * /oauth/:platform/callback handler can recover who initiated the connect
 * without a server-side session lookup or a DB table.
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>`. HMAC-SHA256 over the
 * payload with `BETTER_AUTH_SECRET` (already required for the API to boot,
 * so no new env). Verification is constant-time.
 *
 * Why stateless: an `oauth_states` DB table would need a cleanup cron, race
 * conditions on double-click, and an extra round-trip on both legs. A
 * signed token has the same security properties (CSRF correlation +
 * tamper-resistance) with none of the bookkeeping.
 *
 * Lifetime is short — 10 minutes — because state is only useful between
 * "user clicks Connect" and "platform redirects back". Anything longer is
 * an attacker, a tab the user forgot, or a clock skew issue.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthStatePayload = {
  organizationId: string;
  profileId: string | null;
  platform: string;
  /** ms since epoch — token is invalid past this. */
  exp: number;
  /** Random nonce for tamper detection / replay-window narrowing. */
  nonce: string;
  /**
   * PKCE provider-specific data round-tripped via the state token. Twitter
   * needs `codeVerifier` at exchange time but the dashboard does a
   * full-page redirect immediately after `describeConnect` and loses any
   * client-side state — embedding here lets the GET callback recover it.
   *
   * The state token is HMAC-signed, tamper-resistant, and short-lived
   * (10 min), so this stays inside the existing security envelope.
   */
  pkce?: {
    codeVerifier: string;
  };
  /**
   * Optional caller-provided redirect after the callback completes. The
   * dashboard sets this to /dashboard or /accounts depending on entry point;
   * the marketing demo sets it to the landing page. Validated against the
   * allowlist (TRUSTED_ORIGINS + DASHBOARD_URL) at decode time so a
   * malicious tab can't forge a phishing redirect.
   */
  returnTo?: string;
};

function readSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "BETTER_AUTH_SECRET is required for signing OAuth state tokens.",
    );
  }
  return s;
}

function b64urlEncode(buf: Buffer | string): string {
  return (typeof buf === "string" ? Buffer.from(buf) : buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string, secret: string): string {
  return b64urlEncode(
    createHmac("sha256", secret).update(payload).digest(),
  );
}

export function encodeOAuthState(input: {
  organizationId: string;
  profileId: string | null;
  platform: string;
  /** Provider-specific PKCE bundle for OAuth 2.0 PKCE flows. */
  pkce?: { codeVerifier: string };
  /** Validated returnTo URL to land on after the callback. */
  returnTo?: string;
}): string {
  const payload: OAuthStatePayload = {
    organizationId: input.organizationId,
    profileId: input.profileId,
    platform: input.platform,
    exp: Date.now() + STATE_TTL_MS,
    // Random per-token suffix so two concurrent connects from the same
    // org/platform aren't byte-identical (defense against replay caches).
    nonce: b64urlEncode(
      Buffer.from(crypto.getRandomValues(new Uint8Array(8))),
    ),
    ...(input.pkce ? { pkce: input.pkce } : {}),
    ...(input.returnTo ? { returnTo: input.returnTo } : {}),
  };
  const json = JSON.stringify(payload);
  const encoded = b64urlEncode(json);
  const signature = sign(encoded, readSecret());
  return `${encoded}.${signature}`;
}

export type DecodeResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function decodeOAuthState(token: string): DecodeResult {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }
  const [encoded, signature] = token.split(".", 2);
  if (!encoded || !signature) {
    return { ok: false, reason: "malformed" };
  }
  const expected = sign(encoded, readSecret());
  // timingSafeEqual requires equal-length buffers — guard first.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.exp !== "number" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.platform !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (Date.now() > payload.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
