import type { Metadata } from "next";
import Link from "next/link";
import { PlatformIcon } from "@/components/PlatformIcon";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { PLATFORMS } from "@/data/platforms";
import { highlight } from "@/lib/highlight";

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
const order: Record<string, number> = { live: 0, trial: 0, pending: 1, planned: 2 };

const WRAP =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";
const PILL_BASE =
  "inline-flex items-center whitespace-nowrap rounded-full px-[10px] py-1 font-mono text-[11px] uppercase tracking-[0.06em]";
const CALLOUT =
  "flex items-start gap-4 rounded-[10px] border border-line border-l-[3px] border-l-acc bg-acc-soft px-6 py-5";
const CALLOUT_TAG =
  "whitespace-nowrap pt-[3px] font-mono text-[10.5px] uppercase tracking-[0.12em] text-acc";
const CALLOUT_P = "m-0 text-[15.5px] leading-[1.6] text-ink";

const seen = new Set<string>();
const platforms = PLATFORMS.filter((p) => {
  if (seen.has(p.slug)) return false;
  seen.add(p.slug);
  return true;
}).sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

const total = platforms.length;
const liveCount = platforms.filter((p) => p.status === "live").length;

export const metadata: Metadata = {
  title: "Supported social media platforms",
  description: `${total} platforms behind one POST. Bluesky, X, and Pinterest are live end-to-end today; the rest are in review.`,
  alternates: { canonical: "/platforms/" },
};

const curlSample = `curl -X POST https://api.letmepost.dev/v1/posts \\
  -H "Authorization: Bearer $LMP_KEY" \\
  -d '{
    "targets": [
      { "platform": "bluesky" },
      { "platform": "linkedin" },
      { "platform": "instagram" },
      { "platform": "pinterest" }
    ],
    "text": "Shipped multi-target publishing today.",
    "media": [{ "mediaId": "med_01HXY…" }]
  }'`;

export default function Platforms() {
  return (
    <>
      <header className={`${WRAP} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/">letmepost</Link> / platforms
        </p>
        <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          Platforms
        </p>
        <h1 className="mb-[26px] max-w-[15ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          Eight platforms. <span className="text-acc">One</span> endpoint.
        </h1>
        <p className="max-w-[58ch] text-[21px] leading-[1.55] text-mut">
          The same <span className="font-mono">POST /v1/posts</span> body publishes
          everywhere. {liveCount} platforms are live end-to-end today; the rest
          flip on the day their review clears, with no code change on your side.
        </p>
      </header>

      <section className={`${WRAP} pt-9 pb-[72px] max-[860px]:pb-16`}>
        <div className="mt-10 grid grid-cols-2 gap-4 max-[860px]:grid-cols-1">
          {platforms.map((p) => (
            <Link
              className="grid grid-cols-[44px_1fr_auto] items-center gap-4 rounded-2xl border border-line bg-panel px-[26px] py-6 text-inherit transition hover:-translate-y-0.5 hover:border-acc"
              href={`/platforms/${p.slug}`}
              key={p.slug}
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-acc-soft text-acc">
                <PlatformIcon platform={p.slug} size={22} />
              </span>
              <span>
                <span className="block font-disp text-[19px] font-semibold">
                  {p.name}
                </span>
                <span className="mt-[5px] block text-[13.5px] leading-[1.45] text-mut">
                  {p.tagline}
                </span>
              </span>
              <span
                className={`${PILL_BASE} ${STATUS_PILL[p.status] ?? "bg-plan-soft text-faint"}`}
              >
                {STATUS_LABEL[p.status] ?? "Planned"}
              </span>
            </Link>
          ))}
        </div>

        <div className={`mt-7 ${CALLOUT}`}>
          <span className={CALLOUT_TAG}>No artificial gates</span>
          <p className={CALLOUT_P}>
            <b>Live</b> means published end-to-end today. <b>In review</b> means
            the publisher is shipped and tested against developer-tier accounts;
            approval flips it live with no code change on your side. Self-hosters
            can BYO platform credentials and skip our shared review entirely.
          </p>
        </div>
      </section>

      <section className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}>
        <p className="mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint">
          The shape never changes
        </p>
        <h2 className="mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]">
          Add a target, not an integration.
        </h2>
        <p className="max-w-[56ch] text-[18px] leading-[1.6] text-mut">
          Every platform is one entry in the{" "}
          <code className="rounded bg-acc-soft px-1.5 py-px font-mono text-[0.88em] text-acc">
            targets
          </code>{" "}
          array. Per-platform overrides are optional; the base post just works.
        </p>
        <div className="mt-9 overflow-hidden rounded-[14px] border border-line bg-code-bg">
          <div className="flex items-center gap-[14px] border-b border-line px-4 py-[11px] font-mono text-xs text-faint">
            <span className="flex gap-[7px]">
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
            </span>
            <span className="ml-auto">publish.sh</span>
          </div>
          <pre
            className="m-0 overflow-x-auto p-[22px] font-mono text-[13px] leading-[1.75] text-code-fg"
            dangerouslySetInnerHTML={{ __html: highlight("bash", curlSample) }}
          />
        </div>
      </section>

      <section className={`${WRAP} pt-0 pb-24 max-[860px]:pb-16`}>
        <div className={CALLOUT}>
          <span className={CALLOUT_TAG}>More coming</span>
          <p className={CALLOUT_P}>
            The roadmap is long. Mastodon, Reddit, YouTube, Telegram, Snapchat,
            Google Business, and the Meta + LinkedIn + TikTok ad APIs are all
            under consideration.{" "}
            <a href="https://github.com/letmepost/letmepost.dev/issues/new">
              Open an issue with the platform you need next →
            </a>
          </p>
        </div>
      </section>

      <section className={WRAP}>
        <FinalCta
          title="Connect your first account in 90 seconds."
          lede="Free during alpha. No credit card. One OAuth flow per platform and your posts go live."
          actions={
            <>
              <a
                className={finalButtonClass("pri")}
                href="https://dashboard.letmepost.dev"
              >
                Start free →
              </a>
              <Link className={finalButtonClass("ghost")} href="/api/publishing">
                See the Publishing API
              </Link>
            </>
          }
        />
      </section>
    </>
  );
}
