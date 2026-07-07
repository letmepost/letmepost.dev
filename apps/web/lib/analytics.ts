export type MarketingPage =
  | "home"
  | "pricing"
  | "blog"
  | "blog-post"
  | "platforms"
  | "platform-detail"
  | "api"
  | "api-detail"
  | "status"
  | "contact"
  | "changelog"
  | "other";

type CtaLocation =
  | "hero"
  | "hero-secondary"
  | "footer"
  | "pricing-tier"
  | "pricing-final"
  | "nav"
  | "platform-page"
  | "api-page"
  | "blog-cta"
  | "home-final";

type CtaTarget =
  | "dashboard"
  | "github"
  | "docs"
  | "contact"
  | "rss"
  | "platform"
  | "pricing";

export type WebEvent =
  | {
      name: "cta.clicked";
      properties: {
        location: CtaLocation;
        target: CtaTarget;
        page: MarketingPage;
        label?: string;
      };
    }
  | {
      name: "nav.dropdown_opened";
      properties: { dropdown: "resources" | "platforms" | "api" };
    }
  | {
      name: "platform_page.viewed";
      properties: { platform: string; status: "live" | "coming-soon" };
    }
  | {
      name: "api_page.viewed";
      properties: { surface: string };
    }
  | {
      name: "pricing.viewed";
      properties: Record<string, never>;
    }
  | {
      name: "blog_post.viewed";
      properties: {
        slug: string;
        tags: string[];
        published_at?: string;
      };
    }
  | {
      name: "docs.link_clicked";
      properties: { from_page: MarketingPage; to_section?: string };
    }
  | {
      name: "rss.subscribed";
      properties: { from_page: MarketingPage };
    }
  | {
      name: "external.github_clicked";
      properties: { from_page: MarketingPage; location?: string };
    }
  | {
      name: "contact.submitted";
      properties: { topic?: string };
    };

declare global {
  interface Window {
    posthog?: {
      capture: (name: string, properties?: Record<string, unknown>) => void;
      [key: string]: unknown;
    };
  }
}

export function track<T extends WebEvent>(event: T): void {
  if (typeof window === "undefined") return;
  const posthog = window.posthog;
  if (!posthog || typeof posthog.capture !== "function") return;
  posthog.capture(event.name, event.properties);
}

export function pageFromPathname(pathname: string): MarketingPage {
  const p = pathname !== "/" ? pathname.replace(/\/$/, "") : pathname;
  if (p === "/" || p === "") return "home";
  if (p === "/pricing") return "pricing";
  if (p === "/blog") return "blog";
  if (p.startsWith("/blog/")) return "blog-post";
  if (p === "/platforms") return "platforms";
  if (p.startsWith("/platforms/")) return "platform-detail";
  if (p === "/api") return "api";
  if (p.startsWith("/api/")) return "api-detail";
  if (p === "/status") return "status";
  if (p === "/contact") return "contact";
  if (p === "/changelog") return "changelog";
  return "other";
}
