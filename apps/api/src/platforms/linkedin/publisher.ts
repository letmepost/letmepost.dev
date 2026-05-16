import type { PublishResult } from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";
import type { Publisher } from "../_shared/publisher.js";
import { LINKEDIN_DEFAULT_VERSION, LinkedInClient } from "./client.js";
import {
  validateLinkedInInput,
  type LinkedInPublishInput,
} from "./preflight.js";

/**
 * Credentials the LinkedIn publisher needs. `accessToken` is the OAuth 2.0
 * bearer; `authorUrn` is the canonical `urn:li:person:{id}` resolved at
 * connect time and persisted in `tokenMetadata.authorUrn`. The dispatch
 * layer pulls both off `DecryptedPlatformAccount`.
 *
 * `apiBase` + `version` are test-overridable so MSW handlers can simulate
 * LinkedIn without leaking the real host.
 */
export type LinkedInCredentials = {
  accessToken: string;
  authorUrn: string;
  apiBase?: string;
  version?: string;
};

export type { LinkedInPublishInput };

export const linkedinPublisher: Publisher<
  LinkedInCredentials,
  LinkedInPublishInput
> = {
  async publish(creds, input): Promise<PublishResult> {
    if (!creds.authorUrn) {
      throw new LetmepostError({
        code: "platform_auth_failed",
        status: 401,
        platform: "linkedin",
        message:
          "LinkedIn account is missing the resolved author URN — reconnect the account.",
        rule: "linkedin.author.unresolved",
        remediation:
          "Disconnect and reconnect the LinkedIn account so we can resolve `urn:li:person:*` from /v2/userinfo.",
      });
    }

    // Preflight before any upstream call. Pure validators — they never
    // touch the network.
    const enriched: LinkedInPublishInput = {
      ...input,
      authorUrn: input.authorUrn ?? creds.authorUrn,
    };
    validateLinkedInInput(enriched);

    const client = new LinkedInClient(
      creds.accessToken,
      creds.apiBase,
      creds.version ?? LINKEDIN_DEFAULT_VERSION,
    );

    const created = await client.createPost({
      authorUrn: enriched.authorUrn,
      text: enriched.text,
      ...(enriched.visibility !== undefined
        ? { visibility: enriched.visibility }
        : {}),
    });

    return {
      // The post URN doubles as the canonical id and the URI a caller can
      // resolve. LinkedIn doesn't return a public web URL on the create
      // response — the URN is the load-bearing identifier.
      id: created.urn,
      platform: "linkedin",
      uri: created.urn,
      createdAt: new Date().toISOString(),
    };
  },
};
