import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Contact: one inbox, real replies in 24h",
  description:
    "letmepost.dev is a solo-dev shop. Messages land in a real inbox and get real replies, usually within 24 hours on weekdays.",
  alternates: { canonical: "/contact/" },
};

const wrap =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";

export default function Contact() {
  return (
    <>
      <header className={`${wrap} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/">letmepost</Link> / contact
        </p>
        <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          Contact
        </p>
        <h1 className="mb-[26px] max-w-[16ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          One inbox. One operator. Real replies.
        </h1>
        <p className="max-w-[58ch] text-[21px] leading-[1.55] text-mut">
          No priority-routing tier, because there is only one person to route to.
          Weekdays you&apos;ll usually hear back inside twenty-four hours.
          Weekends are slower and we don&apos;t apologise for that.
        </p>
      </header>

      <section className={`${wrap} pt-7 pb-[72px] max-[860px]:pb-16`}>
        <div className="prose">
          <p>
            letmepost.dev is operated by M/S Rose Creator (trading as
            letmepost.dev), a sole proprietorship based in India. Solo-dev shop.
            Apache 2.0 source on GitHub: file an issue, send a PR, fork it.
          </p>

          <h2>Email</h2>
          <p>
            <a href="mailto:support@letmepost.dev">support@letmepost.dev</a> for
            anything: product questions, privacy, security, bug reports.
          </p>

          <h2>Security disclosures</h2>
          <p>
            Found a vulnerability? Please email the address above with{" "}
            <code>[security]</code> in the subject line. Please don&apos;t file a
            public GitHub issue for security reports.
          </p>

          <h2>Open source</h2>
          <p>
            <a
              href="https://github.com/rosekamallove/letmepost.dev"
              rel="noopener"
              target="_blank"
              data-analytics-event="external.github_clicked"
              data-analytics-props='{"from_page":"contact","location":"contact-body"}'
            >
              github.com/rosekamallove/letmepost.dev
            </a>{" "}
            — file issues, send PRs, read the roadmap.
          </p>

          <h2>Business address</h2>
          <p>
            Registered address is disclosed on request for billing / platform
            verification purposes. Email us.
          </p>
        </div>
      </section>
    </>
  );
}
