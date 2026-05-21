/**
 * Idempotency-Key generator. `crypto.randomUUID` ships in every Node >=18,
 * Deno, Bun, and browser. We don't fall back to a userland UUID v4 because
 * the API requires a high-entropy key and the polyfill cost isn't worth it.
 */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) {
    throw new Error(
      "globalThis.crypto.randomUUID is not available. Upgrade to Node >=18 or pass an explicit idempotencyKey.",
    );
  }
  return c.randomUUID();
}
