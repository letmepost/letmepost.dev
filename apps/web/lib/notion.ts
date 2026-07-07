import { Client, isFullPage } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { toString as mdastToString } from "mdast-util-to-string";
import GithubSlugger from "github-slugger";

export type BlogHeading = { slug: string; text: string; depth: number };

export type BlogPost = {
  id: string;
  title: string;
  description: string;
  pubDate: Date;
  updatedDate?: Date;
  author: string;
  tags: string[];
  category: "engineering" | "philosophy" | "release-notes";
  heroImage?: string;
  readingTime: number;
  draft: boolean;
  canonicalUrl?: string;
  body: string;
  html: string;
  headings: BlogHeading[];
};

type RichText = { plain_text: string };
type NotionCover =
  | { type: "external"; external: { url: string } }
  | { type: "file"; file: { url: string } }
  | null;
type NotionPage = {
  id: string;
  properties: Record<string, unknown>;
  cover: NotionCover;
  lastEdited: string;
};

function plainText(prop: unknown): string | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as {
    type?: string;
    title?: RichText[];
    rich_text?: RichText[];
  };
  const arr = p.type === "title" ? p.title : p.rich_text;
  if (!arr || arr.length === 0) return undefined;
  return (
    arr
      .map((t) => t.plain_text)
      .join("")
      .trim() || undefined
  );
}

function dateStart(prop: unknown): string | undefined {
  if (!prop || typeof prop !== "object") return undefined;
  const p = prop as { date?: { start?: string } };
  return p.date?.start;
}

function coverUrl(cover: NotionCover): string | undefined {
  if (!cover) return undefined;
  if (cover.type === "external") return cover.external.url;
  if (cover.type === "file") return cover.file.url;
  return undefined;
}

function stripInlineToc(markdown: string): string {
  return markdown.replace(
    /^[\s>*_]*\*?\*?Table of Contents\*?\*?[\s>*_]*$/gim,
    "",
  );
}

function addImageAlts(markdown: string, fallback: string): string {
  let currentHeading = fallback;
  return markdown
    .split("\n")
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
      if (heading) {
        currentHeading = heading[1].trim();
        return line;
      }
      return line.replace(
        /!\[\]\((https?:\/\/[^\s)]+)\)/g,
        (_, url) => `![Figure: ${currentHeading}](${url})`,
      );
    })
    .join("\n");
}

function stripOutrankAttribution(markdown: string): string {
  return markdown.replace(
    /\n?\*Built with \*\[\*the Outrank app\*\]\([^)]+\)\s*$/i,
    "",
  );
}

function demoteHeadings(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/^(#{1,5})(\s+)/, "#$1$2");
    })
    .join("\n");
}

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

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, blogSanitizeSchema)
  .use(rehypeSlug)
  .use(rehypeStringify);

async function renderMarkdown(body: string): Promise<string> {
  const file = await processor.process(body);
  return String(file);
}

function extractHeadings(body: string): BlogHeading[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body);
  const slugger = new GithubSlugger();
  const headings: BlogHeading[] = [];
  visit(tree, "heading", (node) => {
    const text = mdastToString(node).trim();
    const slug = slugger.slug(text);
    if (node.depth === 2 || node.depth === 3) {
      if (/^table of contents$/i.test(text)) return;
      headings.push({ slug, text, depth: node.depth });
    }
  });
  return headings;
}

function readingMinutes(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

async function loadAllPosts(): Promise<BlogPost[]> {
  const token = process.env.NOTION_TOKEN ?? "";
  const databaseId = process.env.NOTION_BLOG_DATABASE_ID ?? "";
  if (!token || !databaseId) {
    console.warn(
      "[notion] NOTION_TOKEN / NOTION_BLOG_DATABASE_ID are not set — blog will be empty.",
    );
    return [];
  }

  const notion = new Client({ auth: token });
  const n2m = new NotionToMarkdown({
    notionClient: notion,
    config: { parseChildPages: false },
  });

  const dbResp = (await notion.databases.retrieve({
    database_id: databaseId,
  })) as { data_sources?: { id: string }[] };
  const dataSourceId = dbResp.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(
      `Notion database ${databaseId} has no data sources — cannot query blog posts.`,
    );
  }

  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const r of res.results) {
      if (isFullPage(r)) {
        pages.push({
          id: r.id,
          properties: r.properties,
          cover: r.cover as NotionCover,
          lastEdited: r.last_edited_time,
        });
      }
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  const posts: BlogPost[] = [];
  for (const page of pages) {
    try {
    const props = page.properties;
    const slug = plainText(props["slug"]);
    if (!slug) continue;
    const title = plainText(props["Title"]) ?? plainText(props["Name"]);
    const description = plainText(props["Meta Description"]);
    const pubDateRaw = dateStart(props["Publish Date"]);
    if (!title || !description || !pubDateRaw) continue;

    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const mdResult = n2m.toMarkdownString(mdBlocks);
    const cleaned = stripInlineToc(mdResult.parent ?? "");
    const noAttribution = stripOutrankAttribution(cleaned);
    const demoted = demoteHeadings(noAttribution);
    const body = addImageAlts(demoted, title);
    if (!body.trim()) continue;

    const html = await renderMarkdown(body);
    const headings = extractHeadings(body);

    posts.push({
      id: slug,
      title,
      description,
      pubDate: new Date(pubDateRaw),
      author: "letmepost.dev",
      tags: [],
      category: "engineering",
      draft: false,
      readingTime: readingMinutes(body),
      ...(coverUrl(page.cover) ? { heroImage: coverUrl(page.cover) } : {}),
      body,
      html,
      headings,
    });
    } catch (err) {
      console.warn(`[notion] skipped page ${page.id}:`, err);
    }
  }

  posts.sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());
  return posts;
}

let postsPromise: Promise<BlogPost[]> | null = null;

export function getAllPosts(): Promise<BlogPost[]> {
  if (!postsPromise) {
    postsPromise = loadAllPosts().catch((err) => {
      postsPromise = null;
      throw err;
    });
  }
  return postsPromise;
}

export async function getPost(slug: string): Promise<BlogPost | undefined> {
  const posts = await getAllPosts();
  return posts.find((p) => p.id === slug);
}

export async function getPublishedPosts(): Promise<BlogPost[]> {
  const posts = await getAllPosts();
  return process.env.NODE_ENV === "production"
    ? posts.filter((p) => p.draft !== true)
    : posts;
}
