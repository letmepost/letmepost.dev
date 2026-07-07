import type { MetadataRoute } from "next";
import { PLATFORMS, APIS } from "@/data/platforms";
import { getPublishedPosts } from "@/lib/notion";

const SITE = "https://letmepost.dev";

type Weight = {
  priority: number;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
};

const ROUTE_WEIGHT: Record<string, Weight> = {
  home: { priority: 1.0, changeFrequency: "weekly" },
  product: { priority: 0.9, changeFrequency: "weekly" },
  pricing: { priority: 0.85, changeFrequency: "monthly" },
  utility: { priority: 0.6, changeFrequency: "monthly" },
  legal: { priority: 0.3, changeFrequency: "yearly" },
};

function classify(pathname: string): Weight {
  if (pathname === "/" || pathname === "") return ROUTE_WEIGHT.home;
  if (pathname.startsWith("/platforms/") || pathname.startsWith("/api/")) {
    return ROUTE_WEIGHT.product;
  }
  if (pathname === "/blog" || pathname.startsWith("/blog/")) {
    return ROUTE_WEIGHT.product;
  }
  if (pathname === "/platforms" || pathname === "/api") {
    return ROUTE_WEIGHT.product;
  }
  if (pathname.startsWith("/pricing")) return ROUTE_WEIGHT.pricing;
  if (
    pathname.startsWith("/privacy") ||
    pathname.startsWith("/terms") ||
    pathname.startsWith("/data-deletion")
  ) {
    return ROUTE_WEIGHT.legal;
  }
  return ROUTE_WEIGHT.utility;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const seen = new Set<string>();
  const platformPaths = PLATFORMS.filter((p) =>
    seen.has(p.slug) ? false : (seen.add(p.slug), true),
  ).map((p) => `/platforms/${p.slug}`);
  const apiPaths = APIS.map((a) => `/api/${a.slug}`);

  const posts = await getPublishedPosts();
  const blogPaths = posts.map((p) => `/blog/${p.id}`);
  const blogLastMod = new Map<string, Date>(
    posts.map((p) => [`/blog/${p.id}`, p.updatedDate ?? p.pubDate]),
  );

  const staticPaths = [
    "/",
    "/pricing",
    "/platforms",
    "/api",
    "/blog",
    "/agents",
    "/about",
    "/contact",
    "/status",
    "/privacy",
    "/terms",
    "/data-deletion",
  ];

  const all = [...staticPaths, ...platformPaths, ...apiPaths, ...blogPaths];

  return all.map((path) => {
    const w = classify(path);
    return {
      url: path === "/" ? `${SITE}/` : `${SITE}${path}/`,
      lastModified: blogLastMod.get(path) ?? now,
      changeFrequency: w.changeFrequency,
      priority: w.priority,
    };
  });
}
