import { z } from "zod";

export const Platform = z.enum([
  "bluesky",
  "facebook",
  "instagram",
  "linkedin",
  "pinterest",
  "threads",
  "twitter",
  // Future: "youtube"  (tiktok deferred to v2)
]);
export type Platform = z.infer<typeof Platform>;

/**
 * A reference to a stored, connected platform account. The actual token
 * lives in the database, AES-256-GCM encrypted at rest, and is resolved
 * server-side by id scoped to the caller's organization.
 *
 * `id` is optional: when the authenticated org has exactly one connected
 * account for the named platform, the server auto-resolves the target. With
 * zero accounts the API returns `validation_failed` /
 * `target.account.not_connected`; with two or more it returns
 * `validation_failed` / `target.account.ambiguous` with the candidate ids in
 * `platformResponse.candidates`.
 */
export const AccountRef = z.object({
  platform: Platform,
  id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "letmepost platform_account id; optional when the org has exactly one connected account for `platform`",
    ),
});
export type AccountRef = z.infer<typeof AccountRef>;
