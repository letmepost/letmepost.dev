import { registerProvider } from "./_shared/provider.js";
import { blueskyProvider } from "./bluesky/provider.js";
import { instagramProvider } from "./instagram/provider.js";
import { linkedinProvider } from "./linkedin/provider.js";
import { metaProvider } from "./meta/provider.js";
import { pinterestProvider } from "./pinterest/provider.js";
import { threadsProvider } from "./threads/provider.js";
import { tiktokProvider } from "./tiktok/provider.js";
import { twitterProvider } from "./twitter/provider.js";

/**
 * Boot-time provider registration. `createApp` imports this module for its
 * side effects so every route can look up providers by platform. New
 * platforms add a single line here.
 *
 * Two paths to an `instagram` row:
 *   1. `metaProvider` (under `facebook`) — Facebook Login for Business
 *      fans out to both `facebook` rows AND `instagram` rows for IG
 *      Business accounts linked to FB Pages. Token = Page Access Token;
 *      tokenMetadata.kind = "instagram"; publisher hits graph.facebook.com.
 *   2. `instagramProvider` — Instagram API with Instagram Login. IG-only
 *      OAuth for Professional accounts that may or may not have a linked
 *      FB Page. Token = IG user token; tokenMetadata.kind = "ig-login";
 *      publisher hits graph.instagram.com.
 *
 * Both paths produce rows keyed by IG `user_id`, so a user connecting
 * via both flows gets an upsert (not a duplicate). The dispatcher reads
 * `tokenMetadata.kind` to choose the right API host at publish time.
 */
registerProvider(blueskyProvider);
registerProvider(instagramProvider);
registerProvider(linkedinProvider);
registerProvider(metaProvider);
registerProvider(pinterestProvider);
registerProvider(threadsProvider);
registerProvider(tiktokProvider);
registerProvider(twitterProvider);

export { getProvider, listRegisteredProviders } from "./_shared/provider.js";
