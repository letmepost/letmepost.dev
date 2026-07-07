import type { Metadata } from "next";
import Link from "next/link";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { getPublishedPosts, type PostSummary } from "@/lib/notion";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Engineering blog: social media API deep-dives",
  description:
    "Engineering notes from the platform-review queue. Version sunsets, async media rejections, idempotency, and the failure modes nobody else writes down.",
  alternates: { canonical: "/blog/" },
};

const WRAP =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function safeHeroUrl(url?: string): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  if (/["'()\\\s]/.test(url)) return undefined;
  return url;
}

export default async function Blog() {
  const posts = await getPublishedPosts();
  const featured: PostSummary | undefined = posts[0];
  const rest = posts.slice(1);
  const featuredBg = featured ? safeHeroUrl(featured.heroImage) : undefined;

  return (
    <>
      <header className={`${WRAP} pt-16 pb-2`}>
        <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          Blog
        </p>
        <h1 className="mb-[26px] max-w-[20ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          Engineering notes from the{" "}
          <span className="text-acc">platform-review queue</span>.
        </h1>
        <p className="max-w-[58ch] text-[21px] leading-[1.55] text-mut">
          The failure modes nobody else writes down: version sunsets, async media
          rejections, double-posting loops, and how a developer-grade publishing
          API handles them.
        </p>
      </header>

      {posts.length === 0 && (
        <section className={`${WRAP} py-24 max-[860px]:py-16`}>
          <p className="max-w-[56ch] text-[18px] leading-[1.6] text-mut">
            No posts yet.{" "}
            <a className="text-acc" href="/rss.xml">
              Subscribe via RSS
            </a>
            .
          </p>
        </section>
      )}

      {featured && (
        <section className={`${WRAP} pb-2`}>
          <Link
            className="group mt-10 grid grid-cols-[1.1fr_0.9fr] gap-0 overflow-hidden rounded-[18px] border border-line text-inherit no-underline transition-colors duration-[140ms] hover:border-acc max-[860px]:grid-cols-1"
            href={`/blog/${featured.id}`}
          >
            <div
              className="flex min-h-[280px] items-center justify-center border-r border-line bg-[repeating-linear-gradient(135deg,var(--color-panel-2)_0_14px,var(--color-bg)_14px_28px)] bg-cover bg-center data-[has-image=1]:bg-no-repeat max-[860px]:min-h-[180px] max-[860px]:border-r-0 max-[860px]:border-b"
              data-has-image={featuredBg ? "1" : "0"}
              style={
                featuredBg
                  ? { backgroundImage: `url("${featuredBg}")` }
                  : undefined
              }
            >
              {!featuredBg && (
                <span className="font-mono text-xs uppercase tracking-[0.04em] text-faint">
                  [ {featured.category} ]
                </span>
              )}
            </div>
            <div className="flex flex-col justify-center p-10">
              <div className="mb-4 font-mono text-xs text-faint">
                {fmtDate(featured.pubDate)} · {featured.author}
              </div>
              <h2 className="mb-[14px] font-disp text-[30px] font-semibold leading-[1.12] tracking-[-0.02em]">
                {featured.title}
              </h2>
              <p className="mb-[18px] text-base leading-[1.55] text-mut">
                {featured.description}
              </p>
            </div>
          </Link>
        </section>
      )}

      {rest.length > 0 && (
        <section className={`${WRAP} pt-6 pb-[72px] max-[860px]:pb-16`}>
          <ul className="mt-10 list-none border-t border-line p-0">
            {rest.map((post) => (
              <li key={post.id}>
                <Link
                  className="group grid grid-cols-[130px_1fr] items-baseline gap-7 border-b border-line py-7 text-inherit no-underline max-[860px]:grid-cols-1 max-[860px]:gap-1.5"
                  href={`/blog/${post.id}`}
                >
                  <span className="pt-1 font-mono text-xs text-faint">
                    {fmtDate(post.pubDate)}
                  </span>
                  <span>
                    <span className="mb-1.5 block font-disp text-[22px] font-semibold leading-[1.2] tracking-[-0.01em] group-hover:text-acc">
                      {post.title}
                    </span>
                    <span className="block max-w-[64ch] text-[15px] leading-[1.55] text-mut">
                      {post.description}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={WRAP}>
        <FinalCta
          title="Stop reading about failure modes. Ship past them."
          lede="Free during alpha. No credit card. Send your first post in ninety seconds."
          actions={
            <>
              <a
                className={finalButtonClass("pri")}
                href="https://dashboard.letmepost.dev"
              >
                Start free →
              </a>
              <a
                className={finalButtonClass("ghost")}
                href="https://docs.letmepost.dev"
              >
                Read the docs ↗
              </a>
            </>
          }
        />
      </section>
    </>
  );
}
