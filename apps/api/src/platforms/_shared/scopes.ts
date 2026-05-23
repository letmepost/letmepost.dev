import type { Platform } from "@letmepost/schemas";

/**
 * Canonical per-platform OAuth scope registry. **Narrow-by-default** — the
 * `write` set is the minimum needed to publish for the v1 Publisher scope.
 * `extended` is optional extras (e.g. read analytics) we don't request unless
 * the caller opts in.
 *
 * This is a direct answer to Ayrshare's broad-scope complaint: users should
 * not have to grant "manage pages, ads, everything" to publish a post.
 *
 * Bluesky is included as `kind: "credentials"` with an empty scope list —
 * app passwords don't have OAuth scopes, but keeping the shape uniform means
 * provider code never special-cases "is this OAuth or not" at the scope layer.
 */

export type PlatformScopeSet = {
  /** The minimum set required to publish. Requested by default. */
  write: readonly string[];
  /** Optional additions callers can opt into (e.g. analytics). Not requested by default. */
  extended: readonly string[];
  /** "credentials" for Bluesky, "oauth" for everything else. */
  kind: "oauth" | "credentials";
};

const SCOPES: Record<Platform, PlatformScopeSet> = {
  bluesky: {
    kind: "credentials",
    write: [],
    extended: [],
  },
  linkedin: {
    kind: "oauth",
    // MVP — personal posting only. `w_member_social` is the Sign-In-with-
    // LinkedIn product scope; available on the standard dev tier without
    // MDP. `openid` + `profile` are needed to mint a stable identifier so
    // completeConnect can resolve the `urn:li:person:*` URN.
    write: ["w_member_social", "openid", "profile"],
    // Org/Company posts and `w_organization_social` require MDP — they ship
    // in the post-approval Phase 6 follow-up slice.
    extended: ["email", "r_organization_social", "w_organization_social"],
  },
  pinterest: {
    kind: "oauth",
    // Publish scope set: read the caller's boards, read/write pins, create
    // boards, and read the user's account info.
    //
    // `user_accounts:read` is required because completeConnect calls
    // `GET /v5/user_account` to pin the platform_account_id to the real
    // Pinterest user (instead of a synthetic uuid). Without this scope
    // Pinterest 403s that call and the whole connect surfaces as
    // platform_rejected.
    //
    // `boards:write` covers the boardless-account case — letting users
    // create their first board from the dashboard instead of dead-ending.
    //
    // Pinterest requires `pins:read` alongside `pins:write` because some
    // endpoints echo the pin back on create.
    write: [
      "boards:read",
      "boards:write",
      "pins:read",
      "pins:write",
      "user_accounts:read",
    ],
    extended: ["pins:read_secret"],
  },
  facebook: {
    kind: "oauth",
    // Facebook Login for Business — Pages-only scope set. We do NOT
    // request `instagram_*` scopes here even though FBLB can grant them;
    // Instagram has its own dedicated OAuth (see `instagram` below) for
    // a clean one-tile-per-platform UX and a smaller App Review surface.
    //
    //   pages_show_list             — list the Pages the user manages.
    //   pages_manage_posts          — create posts on Pages.
    //   pages_read_engagement       — required pre-req for post publishing.
    //   business_management         — needed for Pages connected via Business.
    write: [
      "pages_show_list",
      "pages_manage_posts",
      "pages_read_engagement",
      "business_management",
    ],
    // Insights / messaging are extended sets we don't request by default.
    extended: ["pages_read_user_content", "pages_manage_engagement"],
  },
  instagram: {
    kind: "oauth",
    // Instagram API with Instagram Login — standalone OAuth path (Meta's
    // 2024 product). Users sign in with their Instagram account directly,
    // no Facebook Page required. Different scope namespace from the
    // FB-Login fan-out: `instagram_business_*` vs `instagram_*`.
    //
    // The FB-Login fan-out still creates instagram rows for users who DO
    // have a linked FB Page (see `facebook` scope set above). Both paths
    // produce instagram rows with the same platformAccountId, so an
    // upsert merges them.
    write: ["instagram_business_basic", "instagram_business_content_publish"],
    extended: [
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
      "instagram_business_manage_insights",
    ],
  },
  threads: {
    kind: "oauth",
    // Threads Graph API standalone OAuth (separate from Facebook Login for
    // Business). `threads_basic` is mandatory — the bare-minimum scope that
    // lets the token call `GET /me`. `threads_content_publish` is what
    // unlocks the create-container + publish flow.
    //
    // Reply / read scopes are extended-only because v1 of the publisher
    // doesn't read replies — the publisher *posts* replies via reply_to_id
    // on the request body, which requires no extra scope (it's a write).
    write: ["threads_basic", "threads_content_publish"],
    extended: ["threads_manage_replies", "threads_read_replies"],
  },
  twitter: {
    kind: "oauth",
    // X OAuth 2.0 scopes: posting needs `tweet.write`; `tweet.read` +
    // `users.read` are required to mint the token at all; `offline.access`
    // is what makes X issue a refresh token.
    write: ["tweet.write", "tweet.read", "users.read", "offline.access"],
    extended: ["like.read", "follows.read"],
  },
  tiktok: {
    kind: "oauth",
    // TikTok Content Posting API scopes. `video.upload` covers the
    // upload-inbox path (push_by_file → user inbox → user manually
    // confirms publish in TikTok's app). The audited `video.publish`
    // (Direct Post) scope is NOT requested in v1 because TikTok has not
    // approved it on our app yet; preflight forces SELF_ONLY on audit
    // accounts to stay inside what the current scope set permits.
    write: ["user.info.basic", "video.upload"],
    extended: ["video.publish", "video.list"],
  },
};

export function writeScopesFor(platform: Platform): readonly string[] {
  return SCOPES[platform].write;
}

/**
 * Wider-than-Platform lookup used where the caller holds a DB-enum value
 * rather than the narrow user-visible Platform union. Unknown platforms
 * return `"oauth"` as the conservative default (most future platforms are
 * OAuth; the boundary check is in getProvider, not here).
 */
export function scopeKindFor(platform: string): PlatformScopeSet["kind"] {
  const known = SCOPES[platform as Platform];
  return known ? known.kind : "oauth";
}

export function scopeSetFor(platform: Platform): PlatformScopeSet {
  return SCOPES[platform];
}
