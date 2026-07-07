import posthog from "posthog-js";

/**
 * PostHog client init. Next runs this before hydration, so window.posthog
 * is ready by the time the pageview/click trackers mount. No-ops when
 * NEXT_PUBLIC_POSTHOG_KEY is unset (local dev stays quiet).
 *
 * Production (and preview) route through the letmepost.dev/_ph reverse
 * proxy — a next.config rewrite forwards it to PostHog server-side, so ad
 * blockers and ITP can't drop the requests at the network layer. Dev talks
 * to the raw host. capture_pageview is off; the PageviewTracker fires
 * $pageview on every route change (the reliable soft-nav fix).
 */
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key) {
  const host =
    process.env.NODE_ENV === "production"
      ? "https://letmepost.dev/_ph"
      : (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com");

  posthog.init(key, {
    api_host: host,
    ui_host: "https://us.posthog.com",
    person_profiles: "always",
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: true,
    cross_subdomain_cookie: true,
  });

  // Expose the singleton on window so lib/analytics `track()` and the
  // delegated click handler (ported verbatim from the Astro chrome) work.
  window.posthog = posthog as unknown as Window["posthog"];
}
