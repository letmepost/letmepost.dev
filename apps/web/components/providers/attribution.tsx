"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const STORAGE_KEY = "lmp_attribution";
const DASHBOARD_HOST = "dashboard.letmepost.dev";
const UTM_PASS_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
];

type Attribution = {
  signupUtmSource?: string;
  signupUtmMedium?: string;
  signupUtmCampaign?: string;
  signupUtmContent?: string;
  signupUtmTerm?: string;
  signupReferrer?: string;
  signupLandingPath?: string;
  signupSource?: string;
};

function safeGet(): Attribution | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function safeSet(value: Attribution) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
  }
}

function captureFromUrl(): Attribution | null {
  const existing = safeGet();
  if (existing && (existing.signupSource || existing.signupReferrer)) {
    return existing;
  }
  const search = new URLSearchParams(window.location.search);
  const utmSource = search.get("utm_source") || "";
  const utmMedium = search.get("utm_medium") || "";
  const utmCampaign = search.get("utm_campaign") || "";
  const utmContent = search.get("utm_content") || "";
  const utmTerm = search.get("utm_term") || "";
  const referrer = document.referrer || "";
  const landingPath = window.location.pathname || "";

  if (!utmSource && !referrer) return null;

  const record: Attribution = {
    signupUtmSource: utmSource || undefined,
    signupUtmMedium: utmMedium || undefined,
    signupUtmCampaign: utmCampaign || undefined,
    signupUtmContent: utmContent || undefined,
    signupUtmTerm: utmTerm || undefined,
    signupReferrer: referrer || undefined,
    signupLandingPath: landingPath || undefined,
    signupSource: utmSource || undefined,
  };
  safeSet(record);
  return record;
}

function buildDashboardSearch(
  attribution: Attribution | null,
  currentSearch: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams();
  UTM_PASS_KEYS.forEach((k) => {
    const v = currentSearch.get(k);
    if (v) params.set(k, v);
  });
  if (attribution) {
    if (attribution.signupUtmSource && !params.has("utm_source"))
      params.set("utm_source", attribution.signupUtmSource);
    if (attribution.signupUtmMedium && !params.has("utm_medium"))
      params.set("utm_medium", attribution.signupUtmMedium);
    if (attribution.signupUtmCampaign && !params.has("utm_campaign"))
      params.set("utm_campaign", attribution.signupUtmCampaign);
    if (attribution.signupUtmContent && !params.has("utm_content"))
      params.set("utm_content", attribution.signupUtmContent);
    if (attribution.signupUtmTerm && !params.has("utm_term"))
      params.set("utm_term", attribution.signupUtmTerm);
    if (attribution.signupReferrer)
      params.set("lmp_referrer", attribution.signupReferrer);
    if (attribution.signupLandingPath)
      params.set("lmp_landing_path", attribution.signupLandingPath);
  }
  return params;
}

function rewriteDashboardLinks() {
  const attribution = safeGet();
  const currentSearch = new URLSearchParams(window.location.search);
  const newParams = buildDashboardSearch(attribution, currentSearch);
  if (newParams.toString() === "") return;

  const anchors = document.querySelectorAll<HTMLAnchorElement>(
    `a[href*="${DASHBOARD_HOST}"]`,
  );
  anchors.forEach((a) => {
    if (a.getAttribute("data-lmp-attr") === "1") return;
    try {
      const url = new URL(a.href);
      newParams.forEach((value, key) => {
        if (!url.searchParams.has(key)) url.searchParams.set(key, value);
      });
      a.href = url.toString();
      a.setAttribute("data-lmp-attr", "1");
    } catch {
    }
  });
}

export function Attribution() {
  const pathname = usePathname();
  useEffect(() => {
    captureFromUrl();
    rewriteDashboardLinks();
  }, [pathname]);
  return null;
}
