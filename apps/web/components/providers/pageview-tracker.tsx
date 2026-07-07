"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { track, pageFromPathname } from "@/lib/analytics";

export function PageviewTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined" || !window.posthog) return;
    window.posthog.capture("$pageview");

    const page = pageFromPathname(pathname);
    switch (page) {
      case "pricing":
        track({ name: "pricing.viewed", properties: {} });
        break;
      case "platform-detail": {
        const slug = pathname
          .replace(/^\/platforms\//, "")
          .replace(/\/$/, "");
        const status = document
          .querySelector("[data-platform-status]")
          ?.getAttribute("data-platform-status");
        track({
          name: "platform_page.viewed",
          properties: {
            platform: slug,
            status: status === "live" ? "live" : "coming-soon",
          },
        });
        break;
      }
      case "api-detail": {
        const surface = pathname.replace(/^\/api\//, "").replace(/\/$/, "");
        track({ name: "api_page.viewed", properties: { surface } });
        break;
      }
      case "blog-post": {
        const slug = pathname.replace(/^\/blog\//, "").replace(/\/$/, "");
        const tagsRaw =
          document
            .querySelector("[data-blog-tags]")
            ?.getAttribute("data-blog-tags") ?? "";
        const tags = tagsRaw ? tagsRaw.split(",").filter(Boolean) : [];
        const publishedAt = document
          .querySelector("[data-blog-published-at]")
          ?.getAttribute("data-blog-published-at");
        track({
          name: "blog_post.viewed",
          properties: {
            slug,
            tags,
            published_at: publishedAt ?? undefined,
          },
        });
        break;
      }
    }
  }, [pathname]);

  return null;
}
