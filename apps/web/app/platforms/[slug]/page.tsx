import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/JsonLd";
import { PlatformIcon } from "@/components/PlatformIcon";
import { buttonClass } from "@/components/ui/button";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { Icon } from "@/lib/icons";
import { faqPageSchema } from "@/lib/seo";
import { highlight } from "@/lib/highlight";
import { PLATFORMS, type Platform } from "@/data/platforms";
import { PLATFORM_CONTENT } from "@/data/platform-content";

export const dynamicParams = false;

const SITE = "https://letmepost.dev";

const STATUS_LABEL: Record<string, string> = {
  live: "Live",
  pending: "In review",
  trial: "Trial",
  planned: "Planned",
};
const STATUS_PILL: Record<string, string> = {
  live: "bg-acc-soft text-acc",
  pending: "bg-warn-soft text-warn",
  trial: "bg-warn-soft text-warn",
  planned: "bg-plan-soft text-faint",
};

const WRAP =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";
const SEC = "py-24 max-[860px]:py-16";
const DIVIDER = `border-t border-line ${SEC}`;
const KICKER =
  "mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint";
const H2 =
  "mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]";
const PILL_BASE =
  "inline-flex items-center whitespace-nowrap rounded-full px-[10px] py-1 font-mono text-[11px] uppercase tracking-[0.06em]";
const CODE_VARS =
  "[&_code]:rounded [&_code]:bg-acc-soft [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.86em] [&_code]:text-acc";

function dedupe(list: readonly Platform[]): Platform[] {
  const seen = new Set<string>();
  return list.filter((p) =>
    seen.has(p.slug) ? false : (seen.add(p.slug), true),
  );
}

function findPlatform(slug: string): Platform | undefined {
  return dedupe(PLATFORMS).find((p) => p.slug === slug);
}

export function generateStaticParams() {
  return dedupe(PLATFORMS).map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const platform = findPlatform(slug);
  if (!platform) return {};
  return {
    title: `${platform.name} API for developers`,
    description: `Publish to ${platform.name} via letmepost.dev. ${platform.tagline}.`,
    alternates: { canonical: `/platforms/${platform.slug}/` },
  };
}

export default async function PlatformDetail({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const platform = findPlatform(slug);
  const content = platform ? PLATFORM_CONTENT[platform.slug] : undefined;
  if (!platform || !content) notFound();

  const firstWord = platform.name.split(" ")[0];
  const allPlatforms = dedupe(PLATFORMS).map((p) => ({
    slug: p.slug,
    name: p.name,
    current: p.slug === platform.slug,
  }));

  const learnMore = [
    { title: "Pricing", body: "Per-org flat rate", href: "/pricing" },
    {
      title: `${platform.name} guide`,
      body: "Complete dev guide",
      href: `https://docs.letmepost.dev/platforms/${platform.slug}`,
    },
    {
      title: "API reference",
      body: "OpenAPI 3.1 spec",
      href: "https://docs.letmepost.dev/api-reference",
    },
  ];

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Platforms", item: `${SITE}/platforms/` },
      { "@type": "ListItem", position: 3, name: platform.name, item: `${SITE}/platforms/${platform.slug}/` },
    ],
  };
  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `${platform.name} API via letmepost.dev`,
    description: platform.pitch,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Flat-rate per org" },
    publisher: { "@id": `${SITE}/#organization` },
  };

  return (
    <>
      <JsonLd
        graphs={[breadcrumbJsonLd, softwareJsonLd, faqPageSchema(content.faqs)]}
      />

      <span
        data-platform-status={
          platform.status === "live" || platform.status === "trial"
            ? "live"
            : "coming-soon"
        }
        hidden
      />

      <header className={`${WRAP} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/platforms">Platforms</Link> / {platform.name}
        </p>
        <p className="mb-[22px] flex items-center gap-[10px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          <span
            className={`${PILL_BASE} ${STATUS_PILL[platform.status] ?? "bg-plan-soft text-faint"}`}
          >
            {STATUS_LABEL[platform.status] ?? "Planned"}
          </span>
          Platform integration
        </p>
        <h1 className="mb-[26px] max-w-[22ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          {content.heroH1.before}{" "}
          <PlatformIcon
            platform={platform.slug}
            size={36}
            className="inline-block align-[-0.12em] mx-[0.14em] text-acc"
          />{" "}
          {content.heroH1.after}
          <br />
          <span className="text-acc">{content.heroH1.emphasize}</span>
        </h1>
        <p
          className="max-w-[52ch] text-[21px] leading-[1.55] text-mut [&_b]:font-semibold [&_b]:text-ink [&_code]:rounded [&_code]:bg-acc-soft [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.86em] [&_code]:text-acc"
          dangerouslySetInnerHTML={{ __html: content.heroLede }}
        />
        <div className="mt-[30px] flex flex-wrap items-center gap-3">
          <a
            className={buttonClass({ variant: "pri", lg: true })}
            href="https://dashboard.letmepost.dev"
            data-analytics-event="cta.clicked"
            data-analytics-props={JSON.stringify({ location: "hero", target: "dashboard", page: "platform-detail", platform: platform.slug })}
          >
            Connect {firstWord} →
          </a>
          <a
            className={buttonClass({ lg: true })}
            href={`https://docs.letmepost.dev/platforms/${platform.slug}`}
          >
            View API docs
          </a>
        </div>
        {content.reassurance && (
          <p
            className="mt-5 font-mono text-[12.5px] text-faint [&_a]:text-acc [&_a]:hover:underline"
            dangerouslySetInnerHTML={{ __html: content.reassurance }}
          />
        )}

        <div className="mt-9 overflow-hidden rounded-[14px] border border-line bg-code-bg">
          <div className="flex items-center gap-[14px] border-b border-line px-4 py-[11px] font-mono text-xs text-faint">
            <span className="flex gap-[7px]">
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
            </span>
            <span className="ml-auto">POST /v1/posts</span>
          </div>
          <pre
            className="m-0 overflow-x-auto p-[22px] font-mono text-[13px] leading-[1.75] text-code-fg"
            dangerouslySetInnerHTML={{
              __html: highlight("json", content.miniCode),
            }}
          />
        </div>
      </header>

      <section className={`${WRAP} ${SEC}`}>
        <p className="mb-[22px] inline-block rounded-full bg-acc-soft px-[14px] py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-acc">
          {content.vsHead}
        </p>
        <div className="grid grid-cols-2 gap-4 max-[860px]:grid-cols-1">
          <div className="rounded-2xl border border-line bg-panel-2 px-7 pt-7 pb-[30px]">
            <h3 className="mb-[18px] font-disp text-[18px] font-semibold tracking-[-0.01em] text-mut">
              {platform.name} Direct
            </h3>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {content.vsDirect.map((p, i) => (
                <li
                  key={i}
                  className={`relative pl-7 text-[14.5px] leading-[1.55] text-mut before:absolute before:left-0 before:top-0 before:font-bold before:text-[#c2603f] before:content-['✗'] [&_b]:font-semibold [&_b]:text-ink ${CODE_VARS}`}
                  dangerouslySetInnerHTML={{ __html: p.body }}
                />
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px]">
            <h3 className="mb-[18px] font-disp text-[18px] font-semibold tracking-[-0.01em] text-acc">
              letmepost API
            </h3>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {content.vsLetmepost.map((p, i) => (
                <li
                  key={i}
                  className={`relative pl-7 text-[14.5px] leading-[1.55] text-mut before:absolute before:left-0 before:top-0 before:font-bold before:text-acc before:content-['✓'] [&_b]:font-semibold [&_b]:text-ink ${CODE_VARS}`}
                  dangerouslySetInnerHTML={{ __html: p.body }}
                />
              ))}
            </ul>
          </div>
        </div>
        {content.costBanner && (
          <div
            className={`mt-4 rounded-xl border-l-[3px] px-5 py-4 text-[15px] leading-[1.55] text-ink [&_b]:font-semibold [&_b]:text-ink ${CODE_VARS} ${content.costBanner.tone === "good" ? "bg-acc-soft border-l-acc" : "bg-[rgba(194,96,63,0.1)] border-l-[#c2603f]"}`}
            dangerouslySetInnerHTML={{ __html: content.costBanner.body }}
          />
        )}
      </section>

      {content.highlight && (
        <section className={`${WRAP} pt-0 pb-24 max-[860px]:pb-16`}>
          <div
            className={`rounded-[14px] border px-[26px] py-6 ${content.highlight.tone === "good" ? "bg-acc-soft border-[color-mix(in_srgb,var(--color-acc)_38%,var(--color-line))]" : "bg-[rgba(194,96,63,0.08)] border-[rgba(194,96,63,0.35)]"}`}
          >
            <h3
              className={`mb-2 font-disp text-[19px] font-semibold ${content.highlight.tone === "good" ? "text-acc-ink" : "text-[#b4502f]"}`}
            >
              {content.highlight.title}
            </h3>
            <p
              className={`m-0 text-[15px] leading-[1.6] text-ink [&_b]:font-semibold ${CODE_VARS}`}
              dangerouslySetInnerHTML={{ __html: content.highlight.body }}
            />
          </div>
        </section>
      )}

      <section className={`${WRAP} ${DIVIDER}`}>
        <p className={KICKER}>Playground</p>
        <h2 className={H2}>Connect, configure, post.</h2>
        <div className="mt-9 overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex flex-wrap gap-[18px] border-b border-line px-[26px] py-[14px] font-mono text-[11px] uppercase tracking-[0.1em] text-faint">
            {content.playground.steps.map((s, i) => (
              <span className={i === 0 ? "text-acc" : undefined} key={i}>
                ▸ {s}
              </span>
            ))}
          </div>
          <div className="px-[26px] py-[30px]">
            <p
              className={`mb-5 text-[15.5px] leading-[1.6] text-mut [&_b]:text-ink ${CODE_VARS}`}
              dangerouslySetInnerHTML={{ __html: content.playground.body }}
            />
            <a
              className={buttonClass({ variant: "pri" })}
              href={content.playground.cta.href}
              data-analytics-event="cta.clicked"
              data-analytics-props={JSON.stringify({ location: "playground", target: "dashboard-connect", page: "platform-detail", platform: platform.slug })}
            >
              {content.playground.cta.label}
            </a>
            <div className="mt-[22px] inline-flex items-center gap-3 rounded-[10px] bg-acc-soft px-4 py-3 text-sm">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-acc text-xs font-bold text-white dark:text-[#06281a]">
                ✓
              </span>
              <b className="text-ink">{content.playground.result}</b>
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">
                {content.playground.resultCaption}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className={`${WRAP} ${DIVIDER}`}>
        <p className={KICKER}>Content types</p>
        <h2 className={H2}>Every {firstWord} surface, one shape.</h2>
        <div className="mt-9 flex flex-wrap gap-[10px]">
          {content.contentTypes.map((ct, i) => (
            <div
              className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-[14px] py-[9px] text-sm [&_svg]:text-acc"
              key={i}
            >
              <Icon icon={`ph:${ct.icon}`} width={15} height={15} />
              <b className="font-semibold text-ink">{ct.label}</b>
              {ct.note && (
                <span className="text-[12.5px] text-faint">· {ct.note}</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className={`${WRAP} ${DIVIDER}`}>
        <p className={KICKER}>How it works</p>
        <h2 className={H2}>Three steps, under two minutes.</h2>
        <div className="mt-9 border-t border-line [counter-reset:step]">
          {content.steps.map((s, i) => (
            <div
              className="grid grid-cols-[44px_1fr] gap-[18px] border-b border-line py-[22px] [counter-increment:step] before:pt-[3px] before:font-mono before:text-sm before:font-semibold before:text-acc before:content-[counter(step,decimal-leading-zero)]"
              key={i}
            >
              <div>
                <h4 className="mb-1.5 font-disp text-[18px] font-semibold text-ink">
                  {s.title}
                </h4>
                <p
                  className={`m-0 text-[15px] leading-[1.6] text-mut [&_b]:text-ink ${CODE_VARS}`}
                  dangerouslySetInnerHTML={{ __html: s.body }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={`${WRAP} ${DIVIDER}`}>
        <p className={KICKER}>Features</p>
        <h2 className={H2}>What we built so you don&apos;t.</h2>
        <div className="mt-10 grid grid-cols-2 gap-4 max-[860px]:grid-cols-1">
          {content.features.map((f, i) => (
            <div
              className="rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px]"
              key={i}
            >
              <div className="grid h-10 w-10 place-items-center rounded-[11px] bg-acc-soft text-acc">
                <Icon icon={`ph:${f.icon}`} width={18} height={18} />
              </div>
              <h3 className="mt-4 mb-[9px] font-disp text-[20px] font-semibold tracking-[-0.01em]">
                {f.title}
              </h3>
              <p
                className={`text-[15px] leading-[1.55] text-mut ${CODE_VARS}`}
                dangerouslySetInnerHTML={{ __html: f.body }}
              />
            </div>
          ))}
        </div>
      </section>

      <section className={`${WRAP} ${DIVIDER}`}>
        <p className={KICKER}>Code example</p>
        <h2 className={H2}>{content.codeExample.caption}</h2>
        <div className="mt-9 overflow-hidden rounded-[14px] border border-line bg-code-bg">
          <div className="flex items-center gap-[14px] border-b border-line px-4 py-[11px] font-mono text-xs text-faint">
            <span className="flex gap-[7px]">
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
            </span>
            <span className="ml-auto">{content.codeExample.file}</span>
          </div>
          <pre
            className="m-0 overflow-x-auto p-[22px] font-mono text-[13px] leading-[1.75] text-code-fg"
            dangerouslySetInnerHTML={{
              __html: highlight("ts", content.codeExample.code),
            }}
          />
        </div>
      </section>

      {content.errorRef && (
        <section className={`${WRAP} pt-0 pb-24 max-[860px]:pb-16`}>
          <div className="mt-9 flex flex-wrap items-center justify-between gap-5 rounded-[14px] border border-line bg-panel px-[26px] py-[22px]">
            <div>
              <h4 className="mb-1 font-disp text-[18px] font-semibold">
                {content.errorRef.title}
              </h4>
              <p className="m-0 text-[14.5px] text-mut">{content.errorRef.body}</p>
            </div>
            <a
              className="whitespace-nowrap font-mono text-xs tracking-[0.06em] text-acc"
              href={content.errorRef.href}
            >
              View error reference →
            </a>
          </div>
        </section>
      )}

      <section className={`${WRAP} ${DIVIDER}`}>
        <p className={KICKER}>Common questions</p>
        <h2 className={H2}>{content.faqSubtitle}</h2>
        <div className="mt-9 border-t border-line">
          {content.faqs.map((f, i) => (
            <div className="border-b border-line py-6" key={i}>
              <p className="mb-2 font-disp text-[18px] font-semibold">{f.q}</p>
              <p
                className="m-0 max-w-[70ch] text-[15.5px] leading-[1.6] text-mut [&_a]:text-acc [&_code]:rounded [&_code]:bg-acc-soft [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:text-acc"
                dangerouslySetInnerHTML={{ __html: f.a }}
              />
            </div>
          ))}
        </div>
      </section>

      <section className={`${WRAP} ${DIVIDER}`}>
        <p className={KICKER}>One API · {allPlatforms.length} platforms</p>
        <h2 className={H2}>{firstWord} is just one of them.</h2>
        <div className="mt-9 grid grid-cols-4 gap-[10px] max-[860px]:grid-cols-2">
          {allPlatforms.map((p) => (
            <Link
              href={`/platforms/${p.slug}`}
              className={`inline-flex items-center gap-[10px] rounded-xl border px-4 py-[14px] text-[14.5px] text-ink transition-colors hover:border-acc [&_svg]:shrink-0 [&_svg]:text-acc ${p.current ? "border-acc bg-acc-soft" : "border-line bg-panel"}`}
              key={p.slug}
            >
              <PlatformIcon platform={p.slug} size={16} />
              {p.name}
            </Link>
          ))}
        </div>
      </section>

      <section className={`${WRAP} pt-0 pb-24 max-[860px]:pb-16`}>
        <p className={KICKER}>Learn more</p>
        <div className="mt-10 grid grid-cols-3 gap-4 max-[860px]:grid-cols-1">
          {learnMore.map((l) => (
            <a
              className="block rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px] text-inherit transition hover:-translate-y-0.5 hover:border-acc"
              href={l.href}
              key={l.title}
            >
              <h3 className="mt-4 mb-[9px] font-disp text-[20px] font-semibold tracking-[-0.01em]">
                {l.title}
              </h3>
              <div className="mt-[14px] font-mono text-[11.5px] text-faint">
                {l.body}
              </div>
            </a>
          ))}
        </div>
      </section>

      {content.marg && content.marg.length > 0 && (
        <section className={`${WRAP} ${DIVIDER}`}>
          <p className={KICKER}>Good to know</p>
          <h2 className={H2}>Notes from the integration.</h2>
          <div className="mt-8 flex flex-col gap-3">
            {content.marg.map((n, i) => (
              <div
                className="flex items-start gap-4 rounded-[10px] border border-line border-l-[3px] border-l-acc bg-acc-soft px-6 py-5"
                key={i}
              >
                <span className="whitespace-nowrap pt-[3px] font-mono text-[10.5px] uppercase tracking-[0.12em] text-acc">
                  {n.tag}
                </span>
                <p
                  className="m-0 text-[15.5px] leading-[1.6] text-ink"
                  dangerouslySetInnerHTML={{ __html: n.body }}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className={WRAP}>
        <FinalCta
          title={content.finalCtaH2}
          lede={<span dangerouslySetInnerHTML={{ __html: content.finalCtaLede }} />}
          actions={
            <>
              <a
                className={finalButtonClass("pri")}
                href="https://dashboard.letmepost.dev"
                data-analytics-event="cta.clicked"
                data-analytics-props={JSON.stringify({ location: "platform-final", target: "dashboard", page: "platform-detail", platform: platform.slug })}
              >
                {content.finalCtaPrimaryLabel}
              </a>
              <a
                className={finalButtonClass("ghost")}
                href={content.finalCtaSecondaryHref}
              >
                {content.finalCtaSecondaryLabel}
              </a>
            </>
          }
        />
      </section>
    </>
  );
}
