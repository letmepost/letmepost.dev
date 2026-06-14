"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { authClient } from "@/lib/auth-client";
import {
  captureAttribution,
  clearAttribution,
  readAttribution,
} from "@/lib/attribution";
import { API_URL } from "@/lib/env";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
const PENDING_PATCH_KEY = "lmp_pending_attribution_patch";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const session = authClient.useSession().data;
  const activeOrg = authClient.useActiveOrganization().data;
  const lastUserIdRef = useRef<string | null>(null);
  const patchedUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    // First-touch attribution capture. Independent of PostHog — runs even
    // if telemetry is disabled so we still know how the user arrived.
    // No-ops on subsequent visits (first-touch only).
    captureAttribution();
  }, []);

  useEffect(() => {
    if (!POSTHOG_KEY) return;
    if (typeof window === "undefined") return;
    if (posthog.__loaded) return;
    // `capture_pageview: false` because Next App Router doesn't fire the
    // DOM events PostHog listens for — we fire `$pageview` manually on
    // pathname/search changes below. Removing this would silently double-
    // count pageviews on the first hard load.
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      person_profiles: "identified_only",
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
      cross_subdomain_cookie: true,
    });
  }, []);

  useEffect(() => {
    if (!POSTHOG_KEY || !posthog.__loaded) return;
    const search = searchParams?.toString();
    const url = search ? `${pathname}?${search}` : pathname;
    posthog.capture("$pageview", { $current_url: url });
  }, [pathname, searchParams]);

  useEffect(() => {
    if (!POSTHOG_KEY || !posthog.__loaded) return;
    const user = session?.user;
    if (!user) {
      if (lastUserIdRef.current) {
        posthog.reset();
        lastUserIdRef.current = null;
      }
      return;
    }
    if (lastUserIdRef.current !== user.id) {
      posthog.identify(user.id, { email: user.email, name: user.name });
      lastUserIdRef.current = user.id;
    }
    if (activeOrg) {
      posthog.group("organization", activeOrg.id, {
        name: activeOrg.name,
        slug: activeOrg.slug,
      });
    }
  }, [session, activeOrg]);

  // OAuth attribution backfill. The sign-up page sets the
  // `lmp_pending_attribution_patch` flag before redirecting to Google /
  // GitHub; once the OAuth round-trip returns a session we PATCH the
  // stashed attribution to the API. Email/password signups don't take
  // this path — they pass attribution inline via `additionalFields`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const user = session?.user;
    if (!user) return;
    if (patchedUserIdRef.current === user.id) return;
    let pending: string | null = null;
    try {
      pending = window.localStorage.getItem(PENDING_PATCH_KEY);
    } catch {
      return;
    }
    if (pending !== "1") return;
    patchedUserIdRef.current = user.id;
    const attribution = readAttribution();
    // Even with no attribution data, clear the flag so we don't retry
    // forever on every session re-read.
    if (!attribution.signupSource && !attribution.signupReferrer) {
      try {
        window.localStorage.removeItem(PENDING_PATCH_KEY);
      } catch {
        // ignore
      }
      return;
    }
    fetch(`${API_URL}/v1/auth/attribution`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attribution),
    })
      .catch(() => {
        // Best-effort: a failed PATCH leaves the user without source
        // attribution. Acceptable — the channel was still captured on
        // signup.started in PostHog, and re-trying on every render
        // would generate noise without recovering.
      })
      .finally(() => {
        try {
          window.localStorage.removeItem(PENDING_PATCH_KEY);
          clearAttribution();
        } catch {
          // ignore
        }
      });
  }, [session]);

  return children as React.ReactElement;
}
