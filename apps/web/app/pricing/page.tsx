import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { buttonClass } from "@/components/ui/button";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { faqPageSchema, pricingProductSchema } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Pricing: flat per-org, no per-profile tax",
  description:
    "Three paid tiers plus self-host, one flat number per month. Free 50/mo, Pro $79 / 5,000, Business $299 / 25,000, self-host unlimited. Profiles, accounts, team members, webhooks, and API keys are all free. Hard caps, never overage surprises.",
  alternates: { canonical: "/pricing/" },
};

const pricing = [
  { tier: "Free", who: "Personal projects · single-platform automations", price: "$0", sub: "forever", posts: "50 posts / mo", cta: "Start for free", href: "https://dashboard.letmepost.dev" },
  { tier: "Pro", who: "Indie SaaS · agencies under 50 clients", price: "$79", sub: "/ mo", posts: "5,000 posts / mo", cta: "Start Pro", href: "https://dashboard.letmepost.dev", hi: true },
  { tier: "Business", who: "Embedded social · uptime SLA · white-label OAuth", price: "$299", sub: "/ mo", posts: "25,000 posts / mo", cta: "Start Business", href: "https://dashboard.letmepost.dev" },
  { tier: "Self-host", who: "Same image · BYO Postgres + Redis · Apache-2.0", price: "$0", sub: "Apache-2.0", posts: "Unlimited", cta: "Self-host docs", href: "https://docs.letmepost.dev/self-host" },
];

const freeAtEveryTier = [
  "Unlimited connected profiles",
  "Unlimited team members",
  "All 8 platforms",
  "Full API surface",
  "Webhook endpoints & events",
  "Idempotency keys",
  "Preflight validation",
  "Scheduling & cancel",
  "Native MCP server + CLI",
];

const faqs = [
  {
    q: "When does billing actually start?",
    a: "Not yet. Alpha is free for everyone. When billing turns on, you get a 60-day grace window from announcement before any charges. We'll email + webhook every billing contact, twice.",
  },
  {
    q: "What happens if I go over my quota?",
    a: "Hard cap, no overages. <b>0 to 79%</b> posts publish normally, no webhook noise. <b>80%</b> fires <code>quota.warning</code> + email to your billing contact. <b>100%</b> fires <code>quota.exceeded</code> + email, and new posts queue rather than publish. Bump to a higher tier and the queued posts publish immediately, or wait for the next billing period.",
  },
  {
    q: "Can I downgrade?",
    a: "Yes, any time. The change takes effect at the next billing period. No downgrade penalty.",
  },
  {
    q: "Do you offer annual billing?",
    a: "Not in v1. Annual + invoiced billing lands when there are enough customers to justify the accounting overhead. Monthly Stripe Checkout in the meantime.",
  },
  {
    q: "Is there a free trial of Pro?",
    a: "No. The Free tier is the trial. It's the full API surface on a 50-post quota, indefinitely. If 50 posts a month is enough, the free tier is permanent.",
  },
  {
    q: "SSO / SCIM / DPA / custom SLA?",
    a: 'Beyond Business. <a href="mailto:rose@letmepost.dev">Email us</a> with what you need. The answer is almost certainly yes; it\'s a question of timing.',
  },
  {
    q: "Refunds?",
    a: 'If something we built is broken and we can\'t fix it in the period, yes. Email <a href="mailto:rose@letmepost.dev">rose@letmepost.dev</a>.',
  },
];

const jsonLd = [
  pricingProductSchema([
    { name: "Free", price: 0, description: "50 posts per month, all 8 platforms, full API surface." },
    { name: "Pro", price: 79, description: "5,000 posts per month, all webhook events, 30-day publish logs." },
    { name: "Business", price: 299, description: "25,000 posts per month, white-label OAuth, 99.9% SLA." },
  ]),
  faqPageSchema(faqs),
];

const wrap =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";
const kicker =
  "mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint";
const h2 =
  "mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]";
const lead = "max-w-[56ch] text-[18px] leading-[1.6] text-mut";

export default function Pricing() {
  return (
    <>
      <JsonLd graphs={jsonLd} />

      <header className={`${wrap} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/">letmepost</Link> / pricing
        </p>
        <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          Pricing
        </p>
        <h1 className="mb-[26px] max-w-[16ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          One flat number. <span className="text-acc">No per-profile tax.</span>
        </h1>
        <p className="max-w-[60ch] text-[21px] leading-[1.55] text-mut">
          One metered thing: posts published. Profiles, connected accounts, team
          members, webhooks and API keys are all free at every tier. Hard caps
          with webhooks at 80% and 100%. No per-seat tax, no surprise overages at
          3am.
        </p>
      </header>

      <section className={`${wrap} pt-10 pb-[72px] max-[860px]:pb-16`}>
        <div className="mt-10 grid grid-cols-4 gap-[14px] max-[860px]:grid-cols-1">
          {pricing.map((p) => (
            <div
              className={`flex flex-col rounded-[14px] border bg-panel px-[22px] py-[26px] ${p.hi ? "border-acc shadow-[0_0_0_1px_var(--color-acc)]" : "border-line"}`}
              key={p.tier}
            >
              <div className="flex items-center justify-between text-[17px] font-bold">
                {p.tier}
                {p.hi && (
                  <span className="rounded-md bg-acc px-[7px] py-[3px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-white">
                    Popular
                  </span>
                )}
              </div>
              <div className="mt-1.5 min-h-[34px] text-[13px] text-mut">
                {p.who}
              </div>
              <div className="mt-[14px] font-disp text-[34px] font-semibold tracking-[-0.02em]">
                {p.price}{" "}
                <small className="text-sm font-normal text-faint">{p.sub}</small>
              </div>
              <div className="mt-1.5 font-mono text-[12.5px] text-faint">
                {p.posts}
              </div>
              <a
                className={buttonClass({
                  variant: p.hi ? "pri" : "ghost",
                  className: "mt-[18px] justify-center",
                })}
                href={p.href}
              >
                {p.cta}
              </a>
            </div>
          ))}
        </div>
        <p className="mt-[18px] font-mono text-[12.5px] text-faint [&_a]:text-acc [&_a]:hover:underline">
          Prices in USD, billed monthly · cancel anytime · <b>Business+</b>{" "}
          (volume / SSO / SCIM / DPA / custom SLA) is enquiry-driven.
        </p>
      </section>

      <section className={`${wrap} py-24 max-[860px]:py-16`}>
        <p className={kicker}>Free at every tier</p>
        <h2 className={h2}>
          You pay for volume. Everything else is included.
        </h2>
        <div className="mt-8 grid grid-cols-3 gap-x-[28px] gap-y-3 max-[860px]:grid-cols-2 max-[560px]:grid-cols-1">
          {freeAtEveryTier.map((f) => (
            <div
              className="flex items-baseline gap-[10px] text-[15px] text-ink before:font-bold before:text-acc before:content-['✓']"
              key={f}
            >
              {f}
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-2xl border border-line bg-acc-soft px-[34px] py-[30px]">
          <h3 className="mb-[10px] font-disp text-[22px] font-semibold">
            The only thing we meter is posts published.
          </h3>
          <p className="max-w-[70ch] text-[16px] leading-[1.6] text-mut">
            A post counts once, the moment it&apos;s accepted for publishing.
            Validation calls don&apos;t count. When you hit your cap the next post
            queues rather than publishing, and you get a webhook. Quota warnings
            fire at 80% and 100%. No metered overage charges, ever.
          </p>
          <div className="mt-[18px] flex flex-wrap gap-[26px]">
            <span className="font-mono text-[12.5px] text-acc">
              quota.warning · 80%
            </span>
            <span className="font-mono text-[12.5px] text-acc">
              quota.exceeded · 100%
            </span>
            <span className="font-mono text-[12.5px] text-acc">
              post queues, never silently drops
            </span>
          </div>
        </div>
      </section>

      <section className={`${wrap} border-t border-line py-24 max-[860px]:py-16`}>
        <p className={kicker}>Why this shape</p>
        <h2 className={h2}>
          Per-profile pricing is the thing we&apos;re replacing.
        </h2>
        <p className={lead}>
          Buffer charges per channel. Ayrshare charges per profile. Sprout
          charges per seat. That&apos;s the model developers hate, so we rejected
          it, not deferred it. Flat per-org, metered on the one thing that
          actually costs us money to deliver: a published post.
        </p>
      </section>

      <section className={`${wrap} py-[72px] max-[860px]:py-16`}>
        <p className={kicker}>Fine print, billing</p>
        <h2 className={h2}>The questions a CFO would ask.</h2>
        <div className="mt-9 border-t border-line">
          {faqs.map((f) => (
            <div className="border-b border-line py-6" key={f.q}>
              <p className="mb-2 font-disp text-[18px] font-semibold">{f.q}</p>
              <p
                className="m-0 max-w-[70ch] text-[15.5px] leading-[1.6] text-mut [&_a]:text-acc [&_code]:rounded [&_code]:bg-acc-soft [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:text-acc"
                dangerouslySetInnerHTML={{ __html: f.a }}
              />
            </div>
          ))}
        </div>
      </section>

      <section className={wrap}>
        <FinalCta
          title="The free tier is the trial."
          lede="Fifty posts a month, full API surface, no credit card. Indefinite. Move to Pro the day your automation outgrows it."
          actions={
            <>
              <a
                className={finalButtonClass("pri")}
                href="https://dashboard.letmepost.dev"
                data-analytics-event="cta.clicked"
                data-analytics-props='{"location":"pricing-final","target":"dashboard","page":"pricing","label":"Send my first post"}'
              >
                Send my first post →
              </a>
              <a
                className={finalButtonClass("ghost")}
                href="mailto:rose@letmepost.dev"
              >
                Email us
              </a>
            </>
          }
        />
      </section>
    </>
  );
}
