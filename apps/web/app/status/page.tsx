import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Status: real uptime, real incidents, no dashboards",
  description:
    "letmepost.dev API, OAuth, webhooks, and per-platform upstream health. The same numbers we look at.",
  alternates: { canonical: "/status/" },
};

const wrap =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";

export default function Status() {
  return (
    <>
      <header className={`${wrap} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/">letmepost</Link> / status
        </p>
        <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          Status
        </p>
        <h1 className="mb-[26px] max-w-[16ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          The same numbers we look at.
        </h1>
        <p className="max-w-[58ch] text-[21px] leading-[1.55] text-mut">
          Status is whatever the metrics say. No green-coloured pixels papering
          over a degraded fan-out. When an upstream platform&apos;s OAuth flakes,
          this page calls it.
        </p>
      </header>

      <section className={`${wrap} pt-7 pb-[72px] max-[860px]:pb-16`}>
        <div className="flex items-start gap-4 rounded-[10px] border border-line border-l-[3px] border-l-acc bg-acc-soft px-6 py-5">
          <span className="whitespace-nowrap pt-[3px] font-mono text-[10.5px] uppercase tracking-[0.12em] text-acc">
            Operational
          </span>
          <p className="m-0 text-[15.5px] leading-[1.6] text-ink">
            <b>All systems operational.</b> Pre-launch. Real uptime and incident
            history surface here once the API takes production traffic.
          </p>
        </div>

        <div className="prose mt-8">
          <h2>Monitored surfaces</h2>
          <ul>
            <li>
              API gateway (<code>api.letmepost.dev</code>)
            </li>
            <li>OAuth connect flows per platform</li>
            <li>Webhook delivery pipeline</li>
            <li>Background publishing workers</li>
            <li>Per-platform upstream health (Bluesky, LinkedIn, X, Meta, …)</li>
          </ul>

          <h2>Subscribing</h2>
          <p>
            Once the status endpoints are wired, you&apos;ll be able to subscribe
            via RSS, email, or a webhook. Until then,{" "}
            <a
              href="https://github.com/rosekamallove/letmepost.dev"
              rel="noopener"
              target="_blank"
            >
              the GitHub repo
            </a>{" "}
            is the source of truth.
          </p>
        </div>
      </section>
    </>
  );
}
