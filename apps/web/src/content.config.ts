import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * Blog collection — MDX files under `src/content/blog/`. The `glob`
 * loader scopes by extension so we can drop a `.txt` README in the
 * directory without it polluting the route table.
 *
 * Frontmatter shape is intentionally narrow:
 *
 *   - `title`         — the post title; renders in the <title> tag and
 *                       on the post page hero.
 *   - `description`   — meta description + OG description. Required so
 *                       every post has a search-engine-friendly summary.
 *   - `pubDate`       — first published. Sort key on the index. Once
 *                       set, never bump it on edits — that's what
 *                       `updatedDate` is for.
 *   - `updatedDate`?  — last edit. Optional; surfaces as "Updated …"
 *                       on the post page when present.
 *   - `author`        — defaults to letmepost.dev. Override per post.
 *   - `tags`          — for tag pages later; the index also surfaces
 *                       them as chips.
 *   - `heroImage`?    — public-path or absolute URL; renders above the
 *                       post body and as the OG image when set.
 *   - `draft`         — when true, hidden in production builds. Always
 *                       visible in dev so authors can preview.
 *   - `canonicalUrl`? — for cross-posted content (e.g. dev.to mirrors)
 *                       so Google attributes correctly.
 *
 * Schema is strict: extra fields trigger a build error. That's the
 * point — typos in frontmatter become build failures, not silent
 * missing OG images in production.
 */
const blog = defineCollection({
  loader: glob({ base: "./src/content/blog", pattern: "**/*.{md,mdx}" }),
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
