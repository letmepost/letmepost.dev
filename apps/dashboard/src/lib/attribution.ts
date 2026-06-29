"use client";

/**
 * First-touch signup attribution.
 *
 * Captures UTM params + referrer + landing path on the user's first arrival
 * at the dashboard origin, then persists in localStorage so they survive
 * the user bouncing through `/sign-in`, `/sign-up`, and any OAuth round-trip
 * before a user row exists. On signup we hand the stashed values to better-
 * auth (email/password path via `additionalFields`; OAuth path via a follow-
 * up PATCH to `/v1/auth/attribution`).
 *
 * First-touch means: once we've stored something for this browser, we don't
 * overwrite. A user who lands via Product Hunt, leaves, returns via Google
 * Ads, and signs up — counts as Product Hunt. That's the right call for
 * "double down on the channel that worked": the channel that EARNED the
 * signup is the channel of first contact.
 */

const STORAGE_KEY = "lmp_attribution";

export type Attribution = {
  signupSource?: string;
  signupUtmSource?: string;
  signupUtmMedium?: string;
  signupUtmCampaign?: string;
  signupUtmContent?: string;
  signupUtmTerm?: string;
  signupReferrer?: string;
  signupLandingPath?: string;
};

/**
 * Derives a single high-level bucket from utm_source + referrer. Read by
 * the dashboard "where did signups come from" funnel without having to
 * join utm_source + referrer logic in every chart.
 */
function deriveSource(
  utmSource: string | undefined,
  referrer: string | undefined,
): string | undefined {
  if (utmSource) return utmSource.toLowerCase();
  if (!referrer) return undefined;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const matches = (domain: string): boolean =>
    host === domain || host.endsWith("." + domain);
  if (matches("producthunt.com")) return "producthunt";
  if (host === "news.ycombinator.com" || host === "hn.algolia.com")
    return "hackernews";
  if (matches("google.com")) return "google";
  if (host === "twitter.com" || host === "x.com" || host === "t.co")
    return "twitter";
  if (matches("bsky.app")) return "bluesky";
  if (matches("linkedin.com") || host === "lnkd.in") return "linkedin";
  if (matches("reddit.com")) return "reddit";
  if (matches("github.com")) return "github";
  if (matches("dev.to")) return "devto";
  if (matches("indiehackers.com")) return "indiehackers";
  if (matches("letmepost.dev")) return undefined; // our own site
  return "referral";
}

/**
 * Reads attribution from the current URL (if present) and stores to
 * localStorage on first arrival. Safe to call on every page mount — only
 * writes once per browser. Returns the stored attribution (which may have
 * been set on an earlier visit) for any caller that needs it immediately.
 */
export function captureAttribution(): Attribution {
  if (typeof window === "undefined") return {};

  // Already stored — preserve first-touch and just return it.
  const existing = readAttribution();
  if (existing.signupSource || existing.signupReferrer) return existing;

  const params = new URLSearchParams(window.location.search);
  const utmSource = params.get("utm_source") ?? undefined;
  const utmMedium = params.get("utm_medium") ?? undefined;
  const utmCampaign = params.get("utm_campaign") ?? undefined;
  const utmContent = params.get("utm_content") ?? undefined;
  const utmTerm = params.get("utm_term") ?? undefined;
  const referrer = document.referrer || undefined;
  const landingPath = window.location.pathname || undefined;

  const attribution: Attribution = {
    signupSource: deriveSource(utmSource, referrer),
    signupUtmSource: utmSource,
    signupUtmMedium: utmMedium,
    signupUtmCampaign: utmCampaign,
    signupUtmContent: utmContent,
    signupUtmTerm: utmTerm,
    signupReferrer: referrer,
    signupLandingPath: landingPath,
  };

  // Nothing worth storing — don't poison the cache with an empty record
  // that would block a later visit's data from landing.
  if (!attribution.signupSource && !attribution.signupReferrer) return {};

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(attribution));
  } catch {
    // localStorage disabled (Safari private mode etc.) — skip silently.
  }
  return attribution;
}

export function readAttribution(): Attribution {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Attribution;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function clearAttribution(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
