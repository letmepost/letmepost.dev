import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";
import icon from "astro-icon";
import tailwindcss from "@tailwindcss/vite";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * Blog posts come from a third-party-writable Notion database and render
 * through Astro's markdown pipeline, which parses raw embedded HTML. Run
 * rehype-sanitize over that content so untrusted `<script>`, event-handler
 * attributes (onerror/onload/…), and `javascript:`/`data:` URLs can never
 * reach the page — the default schema strips all of those and drops raw
 * HTML nodes entirely. Sanitize runs before Astro's internal rehype-raw
 * step, so raw HTML never survives to be re-parsed. The only extension to
 * the default schema re-allows the inline `style` Shiki emits for syntax
 * highlighting; that's safe because untrusted raw HTML (the only vector
 * for a hostile `style`) is dropped, leaving Shiki's own styles as the
 * sole source.
 */
const blogSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), "style", "className"],
    code: [...(defaultSchema.attributes?.code ?? []), "style"],
    pre: [
      ...(defaultSchema.attributes?.pre ?? []),
      "style",
      "className",
      "tabindex",
    ],
  },
};

/**
 * Per-route SEO weighting. Tells Google how to prioritize crawling the
 * marketing pages relative to each other. The home page + the platform /
 * API marketing pages carry the most commercial intent; legal pages stay
 * low so they don't outrank product content for brand queries.
 * `changefreq` is a hint, not a contract — Google uses its own freshness
 * signal — but it's still useful for less-aggressive crawlers (Bing,
 * AI-search ingestion bots).
 */
const ROUTE_WEIGHT = {
  home: { priority: 1.0, changefreq: "weekly" },
  product: { priority: 0.9, changefreq: "weekly" },
  pricing: { priority: 0.85, changefreq: "monthly" },
  utility: { priority: 0.6, changefreq: "monthly" },
  legal: { priority: 0.3, changefreq: "yearly" },
};

function classify(pathname) {
  if (pathname === "/" || pathname === "") return ROUTE_WEIGHT.home;
  if (pathname.startsWith("/platforms/") || pathname.startsWith("/api/")) {
    return ROUTE_WEIGHT.product;
  }
  // /blog/[slug] are content; the index lives at /blog. Both get the
  // same weight as product pages — blog posts are the long-tail SEO
  // surface that brings in the developer audience over time.
  if (pathname === "/blog" || pathname.startsWith("/blog/")) {
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

export default defineConfig({
  site: "https://letmepost.dev",
  markdown: {
    rehypePlugins: [[rehypeSanitize, blogSanitizeSchema]],
  },
  integrations: [
    // MDX support for the /blog content collection. Order matters —
    // mdx() must come before sitemap() so the sitemap integration sees
    // the generated /blog/[slug] routes.
    mdx(),
    sitemap({
      // `serialize` runs per URL — Astro hands us the auto-discovered
      // entry, we add the priority + changefreq + lastmod that Google's
      // sitemap protocol expects. lastmod is set to build time, so each
      // deploy refreshes the freshness signal on every page.
      serialize(item) {
        const url = new URL(item.url);
        const weight = classify(url.pathname);
        return {
          ...item,
          priority: weight.priority,
          changefreq: weight.changefreq,
          lastmod: new Date().toISOString(),
        };
      },
    }),
    icon(),
  ],
  output: "static",
  build: {
    format: "directory",
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
