import type { Metadata } from "next";
import Link from "next/link";
import { FanoutDiagram } from "@/components/FanoutDiagram";
import { PaidInFullLedger } from "@/components/PaidInFullLedger";
import { ErrorEnvelope } from "@/components/ErrorEnvelope";
import { CodeTabs } from "@/components/CodeTabs";
import { JsonLd } from "@/components/JsonLd";
import { Reveal } from "@/components/Reveal";
import { buttonClass } from "@/components/ui/button";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { highlight } from "@/lib/highlight";
import { getPublishedPosts } from "@/lib/notion";

const description =
  "One POST, eight platforms. X, Bluesky, and Pinterest live today; the rest in review. 80 preflight rules, idempotency, structured errors, native MCP server. Apache 2.0, real free tier.";

export const metadata: Metadata = {
  title: "Open-source social media publishing API",
  description,
  alternates: { canonical: "/" },
};

const pillars = [
  {
    n: "01",
    h: "We absorbed the platform reviews",
    p: "Meta App Review and LinkedIn's Marketing Developer Platform take weeks each. letmepost is the reviewed app of record. Connect through our OAuth and publish through our approved apps. X, Bluesky, and Pinterest are live today; the rest are in platform review.",
    tg: "OAuth · reviewed app of record",
  },
  {
    n: "02",
    h: "It fails loudly, never silently",
    p: "Eighty preflight rules run locally before any platform sees the request. Every error names the exact rule, the pinned platform version, and how to fix it, with a docs link. No empty 500s.",
    tg: "80 rules · 11 stable error codes",
  },
  {
    n: "03",
    h: "Always safe to retry",
    p: "Every write accepts an Idempotency-Key. Retries return the cached response for 24 hours, so a flaky network never turns into a double post.",
    tg: "idempotent writes",
  },
  {
    n: "04",
    h: "Open source, priced per org",
    p: "Apache-2.0 from the first commit. The hosted image is the exact one you can self-host. Flat price per organization. Never per profile, never per seat.",
    tg: "self-host free forever",
  },
];

const pricing = [
  { tier: "Free", who: "Personal automations & side projects", price: "$0", sub: "forever", posts: "50 posts / mo", cta: "Start for free", href: "https://dashboard.letmepost.dev" },
  { tier: "Pro", who: "Indie SaaS · small agencies", price: "$79", sub: "/ mo", posts: "5,000 posts / mo", cta: "Start Pro", href: "https://dashboard.letmepost.dev", hi: true },
  { tier: "Business", who: "Embedded social · SLA · white-label OAuth", price: "$299", sub: "/ mo", posts: "25,000 posts / mo", cta: "Start Business", href: "https://dashboard.letmepost.dev" },
  { tier: "Self-host", who: "Your infra · BYO Postgres + Redis", price: "$0", sub: "Apache-2.0", posts: "Unlimited", cta: "Self-host docs", href: "https://docs.letmepost.dev/self-host" },
];

const faqs = [
  {
    q: "What actually works today?",
    a: "Bluesky, X, and Pinterest are live end-to-end. Connect an account, send a post, attach images or video, and get a webhook back. Instagram, Facebook, Threads, and LinkedIn are in platform review and flip on the day approval clears; TikTok is in App Review.",
  },
  {
    q: "Why another social media API?",
    a: "Because the existing ones fail silently, charge per-profile, and break every six months when a platform sunsets a version. This one fails loudly, charges per-org, and pins the version internally. Apache 2.0 from day one.",
  },
  {
    q: "How much does it cost?",
    a: 'Flat-rate per org. A real free tier covers 50 posts a month. <a href="/pricing">Full pricing →</a>',
  },
  {
    q: "Is it really open source?",
    a: "Apache 2.0. The hosted SaaS runs the exact same image you can self-host. No feature gate, no open-core trick.",
  },
  {
    q: "Do I have to handle Meta App Review myself?",
    a: "No. Connect through our OAuth flow and you publish through our reviewed app. Self-hosters can BYO Meta app if they want their own reviewer-of-record.",
  },
  {
    q: "Can my AI agent drive this?",
    a: 'Yes. Native MCP server at <code class="inl">api.letmepost.dev/mcp</code> and a stdio binary on npm. See the <a href="/agents">agents landing</a> for the full tool surface.',
  },
];

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, "");
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: stripHtml(f.a) },
  })),
};

const curlSample = `curl -X POST https://api.letmepost.dev/v1/posts \\
  -H "Authorization: Bearer $LMP_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "targets": [
      { "platform": "bluesky" },
      { "platform": "x" },
      { "platform": "pinterest" }
    ],
    "text": "Shipped multi-target publishing today."
  }'`;

const tsSample = `import { Letmepost } from "@letmepost/sdk";

const lmp = new Letmepost({ apiKey: process.env.LMP_KEY });

const result = await lmp.posts.create({
  targets: [
    { platform: "bluesky" },
    { platform: "x" },
    { platform: "pinterest" },
  ],
  text: "Shipped multi-target publishing today.",
  // Idempotency-Key stamped automatically.
});

// Per-target outcomes, never a single ambiguous boolean.
for (const r of result.targets) {
  console.log(r.platform, r.status, r.url ?? r.error?.code);
}`;

const pySample = `from letmepost import Letmepost

lmp = Letmepost(api_key=os.environ["LMP_KEY"])

result = lmp.posts.create(
    targets=[
        {"platform": "bluesky"},
        {"platform": "x"},
        {"platform": "pinterest"},
    ],
    text="Shipped multi-target publishing today.",
)

for r in result.targets:
    print(r.platform, r.status, r.url or r.error.code)`;

const mcpConfig = `{
  "mcpServers": {
    "letmepost": {
      "command": "npx",
      "args":    ["@letmepost/mcp@latest"],
      "env":     { "LMP_API_KEY": "lmp_live_…" }
    }
  }
}`;

function fmtPostDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const wrap =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";
const kicker =
  "mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint";
const h2 =
  "mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]";
const lead = "max-w-[56ch] text-[18px] leading-[1.6] text-mut";

export default async function Home() {
  const recentPosts = (await getPublishedPosts()).slice(0, 3);

  const codeTabs = [
    { id: "curl", label: "curl", file: "publish.sh", html: highlight("bash", curlSample) },
    { id: "ts", label: "typescript", file: "publish.ts", html: highlight("ts", tsSample) },
    { id: "py", label: "python", file: "publish.py", html: highlight("python", pySample) },
  ];

  return (
    <>
      <JsonLd graphs={[faqJsonLd]} />

      <Reveal>
        <header
          className={`${wrap} pt-[clamp(60px,7vw,96px)] pb-[clamp(36px,4vw,56px)]`}
        >
          <div className="grid grid-cols-[1.02fr_0.98fr] items-center gap-[52px] max-[980px]:grid-cols-1 max-[980px]:gap-9">
            <div>
              <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
                Open-source social publishing API
              </p>
              <h1 className="mb-[22px] max-w-[16ch] font-disp text-[54px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[980px]:max-w-none max-[980px]:text-[44px] max-[560px]:text-[34px]">
                OSS social media API.
                <br />
                <span className="text-acc">
                  Built for developers and AI agents.
                </span>
              </h1>
              <p className="max-w-[48ch] text-[21px] leading-[1.55] text-mut max-[980px]:max-w-none [&_b]:font-semibold [&_b]:text-ink">
                Ship social features in <b>minutes, not months</b>. One{" "}
                <span className="font-mono">POST</span> fans out to eight
                platforms with scheduling, webhooks, and idempotency built in. It
                speaks native MCP for your agents, and it&apos;s{" "}
                <b>Apache 2.0</b>.
              </p>
              <div className="mt-[30px] flex flex-wrap items-center gap-3">
                <a
                  className={buttonClass({ variant: "pri", lg: true })}
                  href="https://dashboard.letmepost.dev"
                  data-analytics-event="cta.clicked"
                  data-analytics-props='{"location":"hero","target":"dashboard","page":"home","label":"Send my first post"}'
                >
                  Send my first post →
                </a>
                <a
                  className={buttonClass({ lg: true })}
                  href="#request"
                  data-analytics-event="cta.clicked"
                  data-analytics-props='{"location":"hero-secondary","target":"code","page":"home","label":"See the code"}'
                >
                  See the code ↓
                </a>
              </div>
              <p className="mt-5 font-mono text-[12.5px] text-faint">
                No credit card required.
              </p>
            </div>

            <div>
              <FanoutDiagram />
            </div>
          </div>
        </header>
      </Reveal>

      <Reveal>
        <section className={`${wrap} py-24 max-[860px]:py-16`} id="request">
          <p className={kicker}>The one call</p>
          <h2 className={h2}>One request in. A result per platform out.</h2>
          <p className={lead}>
            No SDK gymnastics, no per-platform branching. Send the targets and
            the text, and get back a structured outcome for every destination.
            Never a single ambiguous boolean.
          </p>
          <CodeTabs tabs={codeTabs} />
        </section>
      </Reveal>

      <Reveal>
        <section
          className={`${wrap} border-t border-line py-24 max-[860px]:py-16`}
        >
          <p className={kicker}>Why it&apos;s different</p>
          <h2 className={h2}>Built like infrastructure, not a wrapper.</h2>
          <p className={lead}>
            The boring guarantees that separate a real API from a weekend script.
          </p>
          <div className="mt-11 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line max-[860px]:grid-cols-1">
            {pillars.map((p) => (
              <div className="bg-bg px-[34px] pt-[34px] pb-[38px]" key={p.n}>
                <div className="font-mono text-xs tracking-[0.1em] text-acc">
                  {p.n}
                </div>
                <h3 className="mt-[14px] mb-3 font-disp text-[22px] font-semibold leading-[1.2] tracking-[-0.01em]">
                  {p.h}
                </h3>
                <p className="text-[15.5px] leading-[1.6] text-mut">{p.p}</p>
                <div className="mt-4 font-mono text-[11.5px] text-faint">
                  {p.tg}
                </div>
              </div>
            ))}
          </div>
        </section>
      </Reveal>

      <Reveal>
        <PaidInFullLedger />
      </Reveal>

      <Reveal>
        <ErrorEnvelope />
      </Reveal>

      <Reveal>
        <section className={`${wrap} py-[72px] max-[860px]:py-16`}>
          <p className={kicker}>For agents</p>
          <h2 className={h2}>
            letmepost speaks <span className="text-acc">MCP</span> natively.
          </h2>
          <p className={lead}>
            A hosted MCP server at{" "}
            <code className="rounded bg-acc-soft px-1.5 py-px font-mono text-[0.88em] text-acc">
              api.letmepost.dev/mcp
            </code>{" "}
            and a stdio binary on npm. Twenty-one tools, autogenerated from
            OpenAPI. Claude, Cursor, Claude Code, opencode, any MCP-aware client
            drives the full surface.
          </p>
          <div className="mt-7 overflow-hidden rounded-[14px] border border-line bg-code-bg">
            <div className="flex items-center gap-[14px] border-b border-line px-4 py-[11px] font-mono text-xs text-faint">
              <span className="flex gap-[7px]">
                <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
                <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
                <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              </span>
              <span className="ml-auto">~/.config/mcp.json</span>
            </div>
            <pre
              className="m-0 overflow-x-auto p-[22px] font-mono text-[13px] leading-[1.75] text-code-fg"
              dangerouslySetInnerHTML={{ __html: highlight("json", mcpConfig) }}
            />
          </div>
          <p className="mt-[18px] font-mono text-[12.5px] text-faint [&_a]:text-acc [&_a]:hover:underline">
            <Link href="/agents">Read the agents landing →</Link>
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section className={`${wrap} py-24 max-[860px]:py-16`}>
          <p className={kicker}>Open source · honest pricing</p>
          <h2 className={h2}>Flat per org. Self-host free forever.</h2>
          <p className={lead}>
            Profiles, connected accounts, team members, webhooks and API keys are
            all free. The only metered thing is posts published, with hard caps
            and webhooks at 80% and 100%. Never a surprise bill.
          </p>
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
                  <small className="text-sm font-normal text-faint">
                    {p.sub}
                  </small>
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
          <p className="mt-[22px] font-mono text-[12.5px] text-faint [&_a]:text-acc [&_a]:hover:underline">
            <Link href="/pricing">Full pricing →</Link>
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section className={`${wrap} py-[72px] max-[860px]:py-16`}>
          <p className={kicker}>Fine print</p>
          <h2 className={h2}>Questions you&apos;d ask in a code review.</h2>
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
      </Reveal>

      {recentPosts.length > 0 && (
        <Reveal>
          <section
            className={`${wrap} border-t border-line py-24 max-[860px]:py-16`}
          >
            <p className={kicker}>Latest writing</p>
            <h2 className={h2}>
              Engineering notes from the platform-review queue.
            </h2>
            <div className="mt-8 grid grid-cols-3 gap-4 max-[860px]:grid-cols-1">
              {recentPosts.map((post) => (
                <Link
                  className="block rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px] text-inherit transition hover:-translate-y-0.5 hover:border-acc"
                  href={`/blog/${post.id}/`}
                  key={post.id}
                >
                  <h3 className="mt-4 mb-[9px] font-disp text-[20px] font-semibold tracking-[-0.01em]">
                    {post.title}
                  </h3>
                  <p className="text-[15px] leading-[1.55] text-mut">
                    {post.description}
                  </p>
                  <div className="mt-[14px] font-mono text-[11.5px] text-faint">
                    {fmtPostDate(post.pubDate)}
                  </div>
                </Link>
              ))}
            </div>
            <p className="mt-[22px] font-mono text-[12.5px] text-faint [&_a]:text-acc [&_a]:hover:underline">
              <Link href="/blog">All writing →</Link>
            </p>
          </section>
        </Reveal>
      )}

      <Reveal>
        <section className={wrap}>
          <FinalCta
            title="Send your first post in 90 seconds."
            lede="Ninety seconds from sign-up to a Bluesky post in production. Star the repo, file an issue when something's weird. We build in the open."
            actions={
              <>
                <a
                  className={finalButtonClass("pri")}
                  href="https://dashboard.letmepost.dev"
                  data-analytics-event="cta.clicked"
                  data-analytics-props='{"location":"home-final","target":"dashboard","page":"home","label":"Send my first post"}'
                >
                  Send my first post →
                </a>
                <a
                  className={finalButtonClass("ghost")}
                  href="https://docs.letmepost.dev"
                  data-analytics-event="docs.link_clicked"
                  data-analytics-props='{"from_page":"home","location":"home-final","to_section":"root"}'
                >
                  Read the docs ↗
                </a>
              </>
            }
          />
        </section>
      </Reveal>
    </>
  );
}
