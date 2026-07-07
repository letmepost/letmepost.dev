import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/JsonLd";
import { buttonClass } from "@/components/ui/button";
import { breadcrumbSchema, ROSE_PERSON_SCHEMA } from "@/lib/seo";
import { getPublishedPosts, getPost } from "@/lib/notion";
import { cn } from "@/lib/utils";

export const dynamicParams = false;

const SITE = "https://letmepost.dev";

const NAV_CARD =
  "flex flex-col gap-1.5 rounded-[14px] border border-line px-5 py-[18px] text-inherit no-underline transition-colors duration-[140ms] hover:border-acc";

export async function generateStaticParams() {
  const posts = await getPublishedPosts();
  return posts.map((post) => ({ slug: post.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: `/blog/${post.id}/` },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      ...(post.heroImage ? { images: [{ url: post.heroImage }] } : {}),
    },
    ...(post.heroImage ? { twitter: { images: [post.heroImage] } } : {}),
  };
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  const allPosts = await getPublishedPosts();
  const currentIdx = allPosts.findIndex((p) => p.id === post.id);
  const nextPost = currentIdx > 0 ? allPosts[currentIdx - 1] : null;
  const prevPost =
    currentIdx >= 0 && currentIdx < allPosts.length - 1
      ? allPosts[currentIdx + 1]
      : null;

  const tags = post.tags.length > 0 ? post.tags : [post.category];
  const tocHeadings = post.headings;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      datePublished: post.pubDate.toISOString(),
      ...(post.updatedDate
        ? { dateModified: post.updatedDate.toISOString() }
        : {}),
      author: { "@id": ROSE_PERSON_SCHEMA["@id"] },
      publisher: { "@id": `${SITE}/#organization` },
      ...(post.heroImage ? { image: post.heroImage } : {}),
      mainEntityOfPage: `${SITE}/blog/${post.id}/`,
    },
    ROSE_PERSON_SCHEMA,
    breadcrumbSchema([
      { name: "Home", url: `${SITE}/` },
      { name: "Blog", url: `${SITE}/blog/` },
      { name: post.title },
    ]),
  ];

  return (
    <>
      <JsonLd graphs={jsonLd} />

      <span data-blog-tags={tags.join(",")} hidden />
      <span data-blog-published-at={post.pubDate.toISOString()} hidden />

      <div className="grid grid-cols-[240px_minmax(0,680px)_220px] justify-center gap-12 px-8 pt-14 pb-0 max-[1180px]:grid-cols-[minmax(0,720px)] max-[760px]:px-5 max-[760px]:pt-8">
        <aside className="max-[1180px]:hidden">
          <div className="sticky top-24 rounded-2xl border border-line bg-panel px-[22px] py-6">
            <p className="mb-[10px] font-mono text-[11px] uppercase tracking-[0.14em] text-acc">
              letmepost
            </p>
            <p className="mb-[10px] font-disp text-[19px] font-semibold leading-[1.22] tracking-[-0.01em] text-ink">
              Post to every network with one API call.
            </p>
            <p className="mb-[18px] text-[13.5px] leading-[1.55] text-mut">
              The open-source social publishing API. One{" "}
              <span className="font-mono">POST</span> fans out to eight platforms, with
              preflight validation, idempotency, and structured errors built in.
            </p>
            <a
              className={buttonClass({
                variant: "pri",
                className: "flex w-full justify-center",
              })}
              href="https://dashboard.letmepost.dev"
              data-analytics-event="cta.clicked"
              data-analytics-props='{"location":"blog-rail","target":"dashboard","page":"blog-post","label":"Start for free"}'
            >
              Start for free →
            </a>
            <a
              className="mt-3 inline-block font-mono text-xs text-mut no-underline hover:text-acc"
              href="https://docs.letmepost.dev"
            >
              Read the docs ↗
            </a>
          </div>
        </aside>

        <article className="min-w-0">
          <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
            <Link href="/blog">Blog</Link> / {tags[0]}
          </p>
          <div className="mb-5 flex gap-2">
            {tags.map((t) => (
              <span
                className="rounded-full bg-acc-soft px-[9px] py-[3px] font-mono text-[10.5px] uppercase tracking-[0.08em] text-acc"
                key={t}
              >
                {t}
              </span>
            ))}
          </div>
          <h1 className="mb-[18px] font-disp text-[42px] font-semibold leading-[1.08] tracking-[-0.025em] text-balance max-[760px]:text-[32px]">
            {post.title}
          </h1>
          <p className="mb-1 max-w-[60ch] text-[20px] leading-[1.5] text-mut">
            {post.description}
          </p>
          <div className="mt-[14px] flex items-center gap-[14px] border-b border-line pt-[18px] pb-7 font-mono text-[12.5px] text-faint">
            <span className="text-ink">{post.author}</span>
            <span>·</span>
            <span>{fmtDate(post.pubDate)}</span>
            <span>·</span>
            <span>{post.readingTime} min read</span>
          </div>

          {post.heroImage && (
            <figure className="my-9">
              <img
                src={post.heroImage}
                alt={post.title}
                loading="eager"
                fetchPriority="high"
                className="block h-auto w-full rounded-[14px] border border-line"
              />
            </figure>
          )}

          <div
            className="prose"
            dangerouslySetInnerHTML={{ __html: post.html }}
          />

          <div className="mt-12 rounded-2xl border border-line bg-acc-soft px-[34px] py-8">
            <h3 className="mb-2 font-disp text-[22px] font-semibold">
              Publish everywhere from one POST.
            </h3>
            <p className="mb-[18px] text-base text-mut">
              Free during alpha. Connect an account and send your first post in
              ninety seconds.
            </p>
            <a
              className={buttonClass({ variant: "pri" })}
              href="https://dashboard.letmepost.dev"
            >
              Start for free →
            </a>
          </div>

          {(prevPost || nextPost) && (
            <nav className="mt-12 grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
              {prevPost ? (
                <Link href={`/blog/${prevPost.id}`} className={NAV_CARD}>
                  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">
                    ← Previous
                  </span>
                  <span className="font-disp text-base font-semibold leading-[1.25] text-ink">
                    {prevPost.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
              {nextPost ? (
                <Link
                  href={`/blog/${nextPost.id}`}
                  className={cn(NAV_CARD, "text-right max-[760px]:text-left")}
                >
                  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">
                    Next →
                  </span>
                  <span className="font-disp text-base font-semibold leading-[1.25] text-ink">
                    {nextPost.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}

          <nav className="mt-12 border-t border-line pt-7">
            <Link
              className="mt-5 font-mono text-[12.5px] tracking-[0.01em] text-faint [&_a]:text-acc [&_a]:hover:underline"
              href="/blog"
            >
              ← All writing
            </Link>
          </nav>
        </article>

        {tocHeadings.length > 0 && (
          <aside className="max-[1180px]:hidden">
            <div className="sticky top-24">
              <p className="mb-[14px] border-b border-line pb-[10px] font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
                On this page
              </p>
              <ul className="m-0 flex list-none flex-col gap-[9px] p-0">
                {tocHeadings.map((h) => (
                  <li key={h.slug}>
                    <a
                      href={`#${h.slug}`}
                      className={cn(
                        "-ml-3 block border-l-2 border-l-transparent pl-3 text-[13px] leading-[1.4] text-mut no-underline transition-colors duration-[120ms] hover:border-l-acc hover:text-acc",
                        h.depth === 3 && "pl-[26px] text-[12.5px]",
                      )}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
