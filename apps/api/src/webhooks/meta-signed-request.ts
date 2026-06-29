import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta's `signed_request` format used by their data-deletion callback and a
 * few legacy auth flows. It's a single string of the shape
 *
 *   <base64url-signature>.<base64url-encoded-json-payload>
 *
 * where the signature is HMAC-SHA256 over the *encoded* payload (the bytes
 * after the dot) keyed with the Meta app secret. The payload, once decoded,
 * is JSON whose `algorithm` field must equal "HMAC-SHA256".
 *
 * Reference: developers.facebook.com/docs/development/build-and-test/app-management-api
 */

export type MetaSignedRequestPayload = {
  algorithm: string;
  user_id: string;
  expires?: number;
  issued_at?: number;
  // Meta sometimes adds extra fields per product — keep loose typing.
  [key: string]: unknown;
};

// Bounds the replay window for the unauthenticated destructive callbacks: a
// captured signed_request is otherwise valid forever (the HMAC never changes).
export const META_SIGNED_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type ParseSignedRequestOptions = {
  maxAgeMs?: number;
  now?: number;
};

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

/**
 * Verify and parse a Meta `signed_request`. Returns the decoded payload on
 * success or `null` for any failure mode (malformed, bad signature, wrong
 * algorithm, missing user_id). Never throws — the caller treats `null` as
 * "reject this request".
 */
export function parseMetaSignedRequest(
  signedRequest: string,
  appSecret: string,
  opts: ParseSignedRequestOptions = {},
): MetaSignedRequestPayload | null {
  if (typeof signedRequest !== "string" || signedRequest.length === 0) {
    return null;
  }
  if (typeof appSecret !== "string" || appSecret.length === 0) {
    return null;
  }

  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;
  if (!encodedSig || !encodedPayload) return null;

  let signature: Buffer;
  let payloadJson: string;
  try {
    signature = base64UrlDecode(encodedSig);
    payloadJson = base64UrlDecode(encodedPayload).toString("utf8");
  } catch {
    return null;
  }

  const expected = createHmac("sha256", appSecret)
    .update(encodedPayload)
    .digest();

  if (signature.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(signature, expected)) return null;
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.algorithm !== "HMAC-SHA256") return null;
  if (typeof p.user_id !== "string" || p.user_id.length === 0) return null;

  const now = opts.now ?? Date.now();

  // Meta sends expires:0 to mean "non-expiring", so only a positive value bounds.
  if (
    typeof p.expires === "number" &&
    Number.isFinite(p.expires) &&
    p.expires > 0 &&
    p.expires * 1000 <= now
  ) {
    return null;
  }

  if (opts.maxAgeMs !== undefined) {
    if (typeof p.issued_at !== "number" || !Number.isFinite(p.issued_at)) {
      return null;
    }
    const issuedAtMs = p.issued_at * 1000;
    if (issuedAtMs > now + CLOCK_SKEW_MS) return null;
    if (now - issuedAtMs > opts.maxAgeMs) return null;
  }

  return p as MetaSignedRequestPayload;
}
