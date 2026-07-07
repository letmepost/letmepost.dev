"use client";

import { useEffect } from "react";

export function AnalyticsClicks() {
  useEffect(() => {
    function onAnyClick(e: MouseEvent) {
      const t = e.target;
      if (!t || !(t instanceof Element)) return;
      const el = t.closest("[data-analytics-event]");
      if (!el) return;
      const name = el.getAttribute("data-analytics-event");
      if (!name) return;
      const raw = el.getAttribute("data-analytics-props");
      let props: Record<string, unknown> = {};
      if (raw) {
        try {
          props = JSON.parse(raw);
        } catch {
          props = {};
        }
      }
      if (window.posthog && typeof window.posthog.capture === "function") {
        window.posthog.capture(name, props);
      }
    }
    document.addEventListener("click", onAnyClick, { capture: true });
    return () =>
      document.removeEventListener("click", onAnyClick, { capture: true });
  }, []);

  return null;
}
