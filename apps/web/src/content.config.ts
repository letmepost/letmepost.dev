import { defineCollection, z } from "astro:content";
import { notionBlogLoader } from "./lib/notion-blog-loader.js";

/**
 * Blog content collection — sourced from the "Outrank <> LMP" Notion
 * database. Outrank writes new articles there; this loader walks the DB
 * at build time and renders them into the site. No local `.mdx` files
 * are read — Notion is the only source of truth so the publishing
 * workflow stays "edit in Notion, redeploy."
 *
 * Schema mirrors the Notion column set:
 *   - `title`       — Notion `Title` (falls back to `Name`).
 *   - `description` — Notion `Meta Description`.
 *   - `pubDate`     — Notion `Publish Date` start.
 *   - `heroImage`   — auto-extracted from the first image in the body.
 *   - `tags` / `category` / `author` / `draft` — defaulted; not on the
 *     Notion DB today.
 *
 * Schema stays strict: a malformed Notion row breaks the build instead
 * of silently shipping bad HTML.
 */
// Env reads are intentionally lazy — `astro sync` (which generates the
// content collection types and is invoked by IDE tooling + `astro check`)
// evaluates this file even without env, so we defer the strict check to
// the loader itself. The loader throws at load() time if either var is
// missing, which is when a real build or dev run actually needs them.
const blog = defineCollection({
  loader: notionBlogLoader({
    token: import.meta.env.NOTION_TOKEN ?? "",
    databaseId: import.meta.env.NOTION_BLOG_DATABASE_ID ?? "",
    skip: import.meta.env.DEV && import.meta.env.SKIP_NOTION_BLOG === "1",
  }),
  schema: z.object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(220),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.string().default("letmepost.dev"),
    tags: z.array(z.string()).default([]),
    category: z
      .enum(["engineering", "philosophy", "release-notes"])
      .default("engineering"),
    heroImage: z.string().optional(),
    readingTime: z.number().int().positive().optional(),
    draft: z.boolean().default(false),
    canonicalUrl: z.string().url().optional(),
  }),
});

export const collections = { blog };
