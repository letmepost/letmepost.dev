import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/JsonLd";
import { Icon } from "@/lib/icons";
import { buttonClass } from "@/components/ui/button";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { faqPageSchema } from "@/lib/seo";
import { highlight } from "@/lib/highlight";
import { APIS } from "@/data/platforms";
import { API_CONTENT } from "@/data/api-content";

export const dynamicParams = false;

const SITE = "https://letmepost.dev";

const surfaceBlurbs: Record<string, string> = {
  publishing: "Text, media, scheduled posts. The primary endpoint.",
  media: "Upload bytes once, reference by mediaId on every post.",
  webhooks: "HMAC-signed delivery for 8 lifecycle events.",
};
const surfaceBadges: Record<string, { method: string; path: string }> = {
  publishing: { method: "POST", path: "/v1/posts" },
  media: { method: "POST", path: "/v1/media" },
  webhooks: { method: "POST", path: "/v1/webhook-endpoints" },
};

const WRAP =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";
const KICKER =
  "mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint";
const CL_H2 =
  "mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]";
const LEAD = "max-w-[56ch] text-[18px] leading-[1.6] text-mut";
const CODE86 =
  "[&_code]:rounded [&_code]:bg-acc-soft [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.86em] [&_code]:text-acc";
const CARD =
  "block rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px] text-inherit transition hover:-translate-y-0.5 hover:border-acc";
const CODE_WINDOW =
  "mt-9 overflow-hidden rounded-[14px] border border-line bg-code-bg";
const CODE_BAR =
  "flex items-center gap-[14px] border-b border-line px-4 py-[11px] font-mono text-xs text-faint";
const CODE_DOT = "inline-block h-[10px] w-[10px] rounded-full bg-line";
const CODE_PRE =
  "m-0 overflow-x-auto p-[22px] font-mono text-[13px] leading-[1.75] text-code-fg";

export function generateStaticParams() {
  return APIS.map((api) => ({ slug: api.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const api = APIS.find((a) => a.slug === slug);
  if (!api) return {};
  return {
    title: `${api.name} API`,
    description: `${api.name} on letmepost.dev. ${api.tagline}.`,
    alternates: { canonical: `/api/${api.slug}/` },
  };
}

export default async function ApiDetail({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const api = APIS.find((a) => a.slug === slug);
  const content = api ? API_CONTENT[api.slug] : undefined;
  if (!api || !content) notFound();

  const allSurfaces = APIS.map((s) => ({
    slug: s.slug,
    name: s.name,
    badge: surfaceBadges[s.slug] ?? API_CONTENT[s.slug]?.badge ?? content.badge,
    blurb: surfaceBlurbs[s.slug] ?? s.tagline,
    current: s.slug === api.slug,
  }));

  const learnMore = [
    { title: "API reference", body: "Full schema + examples", href: "https://docs.letmepost.dev/api-reference" },
    { title: "Quickstart", body: "90 seconds to first request", href: "https://docs.letmepost.dev/quickstart" },
    { title: "Self-host", body: "Same image, your infra", href: "https://docs.letmepost.dev/self-host" },
  ];

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "API surfaces", item: `${SITE}/api/` },
      { "@type": "ListItem", position: 3, name: api.name, item: `${SITE}/api/${api.slug}/` },
    ],
  };

  return (
    <>
      <JsonLd graphs={[breadcrumbJsonLd, faqPageSchema(content.faqs)]} />

      <header className={`${WRAP} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/api">APIs</Link> / {api.name}
        </p>
        <div className="flex flex-wrap gap-2">
          {APIS.map((s) => (
            <Link
              className={`rounded-full border px-[14px] py-2 font-mono text-[13px] ${
                s.slug === api.slug
                  ? "border-ink bg-ink text-bg dark:border-acc dark:bg-acc dark:text-[#06281a]"
                  : "border-line text-mut hover:border-ink hover:text-ink"
              }`}
              href={`/api/${s.slug}`}
              key={s.slug}
            >
              {s.name.replace(/ API$/, "")}
            </Link>
          ))}
        </div>
        <span className="mt-[22px] mb-[22px] inline-flex items-center gap-2 rounded-lg bg-code-bg px-[14px] py-[7px] font-mono text-xs tracking-[0.04em] text-code-fg">
          <span className="font-semibold text-acc">{content.badge.method}</span>
          <span>{content.badge.path}</span>
        </span>
        <h1 className="mb-[26px] max-w-[16ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          {content.heroH1.prefix}{" "}
          <span className="underline decoration-acc decoration-4 underline-offset-8">
            {content.heroH1.underlined}
          </span>
          {content.heroH1.suffix}
        </h1>
        <p className="-mt-[10px] mb-4 font-disp text-[22px] font-semibold leading-[1.2] tracking-[-0.01em] text-acc">
          {content.heroSub}
        </p>
        <p
          className={`max-w-[52ch] text-[21px] leading-[1.55] text-mut [&_b]:font-semibold [&_b]:text-ink ${CODE86}`}
          dangerouslySetInnerHTML={{ __html: content.heroLede }}
        />
        <div className="mt-[30px] flex flex-wrap items-center gap-3">
          <a
            className={buttonClass({ variant: "pri", lg: true })}
            href="https://dashboard.letmepost.dev"
            data-analytics-event="cta.clicked"
            data-analytics-props={JSON.stringify({ location: "hero", target: "dashboard", page: "api-detail", surface: api.slug })}
          >
            Get an API key →
          </a>
          <a
            className={buttonClass({ lg: true })}
            href={content.finalCtaSecondaryHref}
          >
            API reference
          </a>
        </div>
        {content.reassurance && (
          <p
            className="mt-5 font-mono text-[12.5px] text-faint [&_a]:text-acc [&_a]:hover:underline"
            dangerouslySetInnerHTML={{ __html: content.reassurance }}
          />
        )}

        <div className={CODE_WINDOW}>
          <div className={CODE_BAR}>
            <span className="flex gap-[7px]">
              <i className={CODE_DOT} />
              <i className={CODE_DOT} />
              <i className={CODE_DOT} />
            </span>
            <span className="ml-auto">
              {content.badge.method} {content.badge.path}
            </span>
          </div>
          <pre
            className={CODE_PRE}
            dangerouslySetInnerHTML={{
              __html: highlight(content.miniCodeLang, content.miniCode),
            }}
          />
        </div>
      </header>

      <section className={`${WRAP} py-24 max-[860px]:py-16`}>
        <p className="mb-[22px] inline-block rounded-full bg-acc-soft px-[14px] py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-acc">
          {content.vsHead}
        </p>
        <div className="grid grid-cols-2 gap-4 max-[860px]:grid-cols-1">
          <div className="rounded-2xl border border-line bg-panel-2 px-7 pt-7 pb-[30px]">
            <h3 className="mb-[18px] font-disp text-[18px] font-semibold tracking-[-0.01em] text-mut">
              {content.vsDirectTitle}
            </h3>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {content.vsDirect.map((p, i) => (
                <li
                  className={`relative pl-7 text-[14.5px] leading-[1.55] text-mut before:absolute before:left-0 before:top-0 before:font-bold before:text-[#c2603f] before:content-['✗'] [&_b]:font-semibold [&_b]:text-ink ${CODE86}`}
                  key={i}
                  dangerouslySetInnerHTML={{ __html: p.body }}
                />
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px]">
            <h3 className="mb-[18px] font-disp text-[18px] font-semibold tracking-[-0.01em] text-acc">
              letmepost {api.name}
            </h3>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {content.vsLetmepost.map((p, i) => (
                <li
                  className={`relative pl-7 text-[14.5px] leading-[1.55] text-mut before:absolute before:left-0 before:top-0 before:font-bold before:text-acc before:content-['✓'] [&_b]:font-semibold [&_b]:text-ink ${CODE86}`}
                  key={i}
                  dangerouslySetInnerHTML={{ __html: p.body }}
                />
              ))}
            </ul>
          </div>
        </div>
        {content.costBanner && (
          <div
            className={`mt-4 rounded-xl border-l-[3px] px-5 py-4 text-[15px] leading-[1.55] text-ink [&_b]:font-semibold [&_b]:text-ink ${CODE86} ${
              content.costBanner.tone === "good"
                ? "border-l-acc bg-acc-soft"
                : "border-l-[#c2603f] bg-[rgba(194,96,63,0.10)]"
            }`}
            dangerouslySetInnerHTML={{ __html: content.costBanner.body }}
          />
        )}
      </section>

      {content.highlight && (
        <section className={`${WRAP} pt-0 pb-24 max-[860px]:pb-16`}>
          <div
            className={`rounded-[14px] border px-[26px] py-6 ${
              content.highlight.tone === "good"
                ? "border-[color-mix(in_srgb,var(--color-acc)_38%,var(--color-line))] bg-acc-soft"
                : "border-[rgba(194,96,63,0.35)] bg-[rgba(194,96,63,0.08)]"
            }`}
          >
            <h3
              className={`mb-2 font-disp text-[19px] font-semibold ${
                content.highlight.tone === "good"
                  ? "text-acc-ink"
                  : "text-[#b4502f]"
              }`}
            >
              {content.highlight.title}
            </h3>
            <p
              className={`m-0 text-[15px] leading-[1.6] text-ink [&_b]:font-semibold ${CODE86}`}
              dangerouslySetInnerHTML={{ __html: content.highlight.body }}
            />
          </div>
        </section>
      )}

      <section
        className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}
      >
        <p className={KICKER}>Capabilities</p>
        <h2 className={CL_H2}>{content.capabilitiesTitle}</h2>
        <p className={LEAD}>{content.capabilitiesSubtitle}</p>
        <div className="mt-9 flex flex-wrap gap-[10px]">
          {content.capabilities.map((ct, i) => (
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

      <section
        className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}
      >
        <p className={KICKER}>How it works</p>
        <h2 className={CL_H2}>{content.stepsTitle}</h2>
        <p className={LEAD}>{content.stepsSubtitle}</p>
        <div className="mt-9 border-t border-line [counter-reset:step]">
          {content.steps.map((s, i) => (
            <div
              className="grid grid-cols-[44px_1fr] gap-[18px] border-b border-line py-[22px] [counter-increment:step] before:pt-[3px] before:font-mono before:text-sm before:font-semibold before:text-acc before:[content:counter(step,decimal-leading-zero)]"
              key={i}
            >
              <div>
                <h4 className="mb-1.5 font-disp text-[18px] font-semibold text-ink">
                  {s.title}
                </h4>
                <p
                  className={`m-0 text-[15px] leading-[1.6] text-mut [&_b]:text-ink ${CODE86}`}
                  dangerouslySetInnerHTML={{ __html: s.body }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section
        className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}
      >
        <p className={KICKER}>Features</p>
        <h2 className={CL_H2}>{content.featuresTitle}</h2>
        <p className={LEAD}>{content.featuresSubtitle}</p>
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
                className={`text-[15px] leading-[1.55] text-mut ${CODE86}`}
                dangerouslySetInnerHTML={{ __html: f.body }}
              />
            </div>
          ))}
        </div>
        {content.alsoPill && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-acc-soft px-[22px] py-4">
            <div
              className={`flex items-center gap-3 text-[14.5px] text-ink [&_b]:font-semibold [&_svg]:shrink-0 [&_svg]:text-acc ${CODE86}`}
            >
              <Icon icon="ph:plus-circle" width={18} height={18} />
              <span dangerouslySetInnerHTML={{ __html: content.alsoPill.body }} />
            </div>
            <a
              className="whitespace-nowrap font-mono text-xs tracking-[0.06em] text-acc"
              href={content.alsoPill.href}
            >
              {content.alsoPill.label}
            </a>
          </div>
        )}
      </section>

      <section
        className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}
      >
        <p className={KICKER}>Code example</p>
        <h2 className={CL_H2}>{content.codeExample.caption}</h2>
        <div className={CODE_WINDOW}>
          <div className={CODE_BAR}>
            <span className="flex gap-[7px]">
              <i className={CODE_DOT} />
              <i className={CODE_DOT} />
              <i className={CODE_DOT} />
            </span>
            <span className="ml-auto">{content.codeExample.file}</span>
          </div>
          <pre
            className={CODE_PRE}
            dangerouslySetInnerHTML={{
              __html: highlight(content.codeExample.lang, content.codeExample.code),
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

      <section
        className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}
      >
        <p className={KICKER}>Common questions</p>
        <h2 className={CL_H2}>{content.faqSubtitle}</h2>
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

      <section
        className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}
      >
        <p className={KICKER}>Other surfaces</p>
        <h2 className={CL_H2}>The rest of the API.</h2>
        <div className="mt-10 grid grid-cols-3 gap-4 max-[860px]:grid-cols-1">
          {allSurfaces.map((s) => (
            <Link
              className={`block rounded-2xl border bg-panel px-7 pt-7 pb-[30px] text-inherit transition hover:-translate-y-0.5 hover:border-acc ${
                s.current ? "border-acc" : "border-line"
              }`}
              href={`/api/${s.slug}`}
              key={s.slug}
            >
              <div className="mb-[10px] font-mono text-[11px] tracking-[0.06em] text-faint">
                <span className="text-acc">{s.badge.method}</span> {s.badge.path}
                {s.current ? " · here" : ""}
              </div>
              <h3 className="mt-4 mb-[9px] font-disp text-[20px] font-semibold tracking-[-0.01em]">
                {s.name}
              </h3>
              <p className="text-[15px] leading-[1.55] text-mut">{s.blurb}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className={`${WRAP} pt-0 pb-24 max-[860px]:pb-16`}>
        <p className={KICKER}>Learn more</p>
        <div className="mt-10 grid grid-cols-3 gap-4 max-[860px]:grid-cols-1">
          {learnMore.map((l) => (
            <a className={CARD} href={l.href} key={l.title}>
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
        <section
          className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}
        >
          <p className={KICKER}>Good to know</p>
          <h2 className={CL_H2}>Notes on the contract.</h2>
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
          lede={
            <span dangerouslySetInnerHTML={{ __html: content.finalCtaLede }} />
          }
          actions={
            <>
              <a
                className={finalButtonClass("pri")}
                href="https://dashboard.letmepost.dev"
                data-analytics-event="cta.clicked"
                data-analytics-props={JSON.stringify({ location: "api-final", target: "dashboard", page: "api-detail", surface: api.slug })}
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
