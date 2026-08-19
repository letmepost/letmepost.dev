import { randomUUID } from "node:crypto";
import type { PublishResult } from "@letmepost/schemas";
import type { DecryptedPlatformAccount } from "../../repositories/platform-accounts.js";

/**
 * Synthetic publish result for an `lmp_test_` key. Shape-identical to a live
 * result so integrators can exercise the full response contract, but ids carry
 * a `sandbox_` prefix and the uri never points at the platform, so a sandbox
 * result can't be mistaken for a real permalink.
 */
export function sandboxPublishResult(
  account: DecryptedPlatformAccount,
): PublishResult {
  const id = `sandbox_${randomUUID().replace(/-/g, "")}`;
  return {
    id,
    platform: account.platform,
    status: "published",
    uri: `https://sandbox.letmepost.dev/${account.platform}/${id}`,
    cid: id,
    createdAt: new Date().toISOString(),
    warnings: [
      {
        code: "sandbox.no_platform_write",
        message:
          "Sandbox key: validation and preflight ran in full, but nothing was sent to the platform.",
      },
    ],
  };
}
