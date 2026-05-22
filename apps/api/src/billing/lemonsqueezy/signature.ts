import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Lemon Squeezy webhook signature. They sign the raw body with
 * HMAC-SHA256 and pass the lowercase hex digest in the `X-Signature` header.
 * Constant-time comparison so timing leaks can't be used to brute the secret.
 */
export function verifyLemonSqueezySignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || signature.length === 0 || secret.length === 0) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8");
  const presentedBytes = Buffer.from(signature, "utf8");
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
}
