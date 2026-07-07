import { getPublishedPosts } from "@/lib/notion";

export const dynamic = "force-static";

const SITE = "https://letmepost.dev";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET() {
  const posts = (await getPublishedPosts()).slice(0, 30);

  const items = posts
    .map((post) => {
      const link = `${SITE}/blog/${post.id}/`;
      const categories = post.tags
        .map((t) => `<category>${esc(t)}</category>`)
        .join("");
      return `    <item>
      <title>${esc(post.title)}</title>
      <description>${esc(post.description)}</description>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${post.pubDate.toUTCString()}</pubDate>
      <dc:creator>${esc(post.author)}</dc:creator>
${categories ? "      " + categories + "\n" : ""}    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>letmepost.dev — Blog</title>
    <description>Field notes from the team building letmepost.dev. API design, platform-integration gotchas, and the failure-modes corpus that drove our product principles.</description>
    <link>${SITE}</link>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml" />
    <language>en-us</language>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
