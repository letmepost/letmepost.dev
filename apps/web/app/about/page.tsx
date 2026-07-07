import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/JsonLd";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { ROSE_PERSON_SCHEMA } from "@/lib/seo";

export const metadata: Metadata = {
  title: "About letmepost.dev: solo, open source, built in public",
  description:
    "letmepost.dev is built by Rose Kamal Love (ex-GrooveHQ, Kroto). Apache 2.0, solo-dev shop, transparent about what works and what doesn't.",
  alternates: { canonical: "/about/" },
};

const wrap =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";

export default function About() {
  return (
    <>
      <JsonLd graphs={[ROSE_PERSON_SCHEMA]} />

      <header className={`${wrap} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/">letmepost</Link> / about
        </p>
        <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          About
        </p>
        <h1 className="mb-[26px] max-w-[16ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          One operator. One inbox. <span className="text-acc">Open source.</span>
        </h1>
        <p className="max-w-[58ch] text-[21px] leading-[1.55] text-mut">
          letmepost.dev is a solo-dev shop building the social media publishing
          API the existing ones aren&apos;t. No funding round, no growth team, no
          per-profile billing tax.
        </p>
      </header>

      <section className={`${wrap} py-[72px] max-[860px]:py-16`}>
        <p className="mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint">
          Who
        </p>
        <h2 className="mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]">
          Rose Kamal Love.
        </h2>
        <div className="prose">
          <p>
            Founder. Solo. Previously engineering at <b>GrooveHQ</b> and{" "}
            <b>Kroto</b>. I&apos;ve shipped customer-facing software for ten years
            and built two products that grew through developer trust, not ad
            spend. letmepost.dev is the third.
          </p>
          <p>
            Find me on{" "}
            <a href="https://github.com/rosekamallove">GitHub</a>,{" "}
            <a href="https://x.com/rosekamallove">X</a>, and{" "}
            <a href="https://bsky.app/profile/rosekamallove.dev">Bluesky</a>.
            Email <a href="mailto:rose@letmepost.dev">rose@letmepost.dev</a>{" "}
            reaches me directly, usually inside 24h on weekdays.
          </p>
        </div>
      </section>

      <section className={`${wrap} border-t border-line py-24 max-[860px]:py-16`}>
        <p className="mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint">
          Why this
        </p>
        <h2 className="mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]">
          Loud failure, per-org billing, pinned versions.
        </h2>
        <div className="prose">
          <p>
            Every existing social media API has the same shape: per-profile
            billing that punishes scale, silent failure modes that punish
            debugging, and a six-month half-life on platform integrations because
            nobody pins API versions.
          </p>
          <p>
            letmepost.dev is the version where failure is loud, billing is
            per-org, version pinning is the contract, and the entire stack is
            Apache 2.0. The hosted SaaS runs the exact image you can self-host.
            No open-core trick.
          </p>
        </div>
      </section>

      <section className={`${wrap} border-t border-line py-24 max-[860px]:py-16`}>
        <p className="mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint">
          How we work
        </p>
        <h2 className="mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]">
          Build in public, honest status.
        </h2>
        <div className="prose">
          <ul>
            <li>
              <b>Build in public.</b> Roadmap, status, and platform-review state
              live on the marketing pages. The{" "}
              <Link href="/status">status page</Link> is the same metrics
              dashboard we look at.
            </li>
            <li>
              <b>Honest status.</b> Bluesky, X, and Pinterest are live
              end-to-end. Instagram, Facebook, Threads, and LinkedIn are in
              platform review; TikTok is in App Review. We never mark a platform
              &quot;available&quot; before it is.
            </li>
            <li>
              <b>No sales call required.</b> Free tier, public pricing, Stripe
              Checkout. Email us if Business+ doesn&apos;t cover what you need,
              but you don&apos;t have to.
            </li>
            <li>
              <b>Open source from day one.</b>{" "}
              <a href="https://github.com/letmepost/letmepost.dev">
                github.com/letmepost
              </a>
              . Apache 2.0. Self-host the same image that runs the hosted SaaS.
            </li>
          </ul>
        </div>
      </section>

      <section className={wrap}>
        <FinalCta
          title="Build on it, or read the source."
          lede="Open an issue, send a PR, or just send your first post. We build in the open."
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
                href="https://github.com/letmepost/letmepost.dev"
              >
                View source ↗
              </a>
            </>
          }
        />
      </section>
    </>
  );
}
