"use client";

import { Suspense, useEffect } from "react";
import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * GA4, alongside PostHog rather than instead of it. PostHog stays the product
 * analytics surface; GA exists so Search Console can attribute organic traffic
 * to landing pages, which PostHog can't do.
 *
 * No-ops when NEXT_PUBLIC_GA_MEASUREMENT_ID is unset, so local dev and any
 * deploy without the var stay quiet — same contract as the PostHog init.
 */
const MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * `send_page_view: false` + an explicit send per route change. GA4's enhanced
 * measurement infers soft navigations from History API events, which
 * double-counts against the initial load and misses the App Router's
 * `searchParams`-only transitions. Same reason PostHog runs with
 * `capture_pageview: false` here.
 */
function Pageviews() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!MEASUREMENT_ID || typeof window === "undefined" || !window.gtag) return;
    const query = searchParams.toString();
    window.gtag("event", "page_view", {
      page_path: query ? `${pathname}?${query}` : pathname,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [pathname, searchParams]);

  return null;
}

export function GoogleAnalytics() {
  if (!MEASUREMENT_ID) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          gtag('config', '${MEASUREMENT_ID}', { send_page_view: false });
        `}
      </Script>
      {/* useSearchParams bails out of static rendering without a boundary,
          which would opt every page into client-side rendering. */}
      <Suspense fallback={null}>
        <Pageviews />
      </Suspense>
    </>
  );
}
