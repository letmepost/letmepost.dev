import type { Metadata } from "next";
import Link from "next/link";

const updated = "2026-04-27";

export const metadata: Metadata = {
  title: "Data Deletion: delete your account and tokens",
  description:
    "How to delete your letmepost.dev account and associated data.",
  alternates: { canonical: "/data-deletion/" },
};

const wrap =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";

export default function DataDeletion() {
  return (
    <>
      <header className={`${wrap} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/">letmepost</Link> / data deletion
        </p>
        <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          Legal
        </p>
        <h1 className="mb-[26px] max-w-[14ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          Data deletion.
        </h1>
        <p className="mt-5 font-mono text-[12.5px] text-faint [&_a]:text-acc [&_a]:hover:underline">
          Last updated: {updated}
        </p>
      </header>

      <section className={`${wrap} pt-7 pb-[72px] max-[860px]:pb-16`}>
        <div className="prose">
          <p>
            letmepost.dev is operated by M/S Rose Creator (trading as letmepost.dev), a sole
            proprietorship based in India. You can have your letmepost.dev account and all
            associated data deleted at any time. This page tells platform reviewers (Meta,
            LinkedIn, X, Pinterest) how that works and gives you a contact path.
          </p>

          <h2>What gets deleted</h2>
          <ul>
            <li>Your user account and organisation.</li>
            <li>All connected social-platform accounts and their OAuth tokens.</li>
            <li>All post records (scheduled, published, failed).</li>
            <li>API keys, webhook endpoints, and any custom configuration tied to your organisation.</li>
          </ul>
          <p>
            Logs older than 30 days are already rotated out. Logs newer than 30 days are
            purged as part of the deletion request; aggregated metrics with no personal data
            may remain.
          </p>

          <h2>How to request deletion</h2>
          <p>Until the self-serve dashboard ships, request deletion by email:</p>
          <ol>
            <li>Send an email from the address on your letmepost.dev account to <a href="mailto:support@letmepost.dev">support@letmepost.dev</a>.</li>
            <li>Subject: <code>Data deletion request</code>.</li>
            <li>We'll confirm within 3 business days and complete deletion within 30 days (faster in practice).</li>
          </ol>

          <p>
            We will email a confirmation once deletion is complete and retain only what is
            legally required (e.g. invoice records for tax purposes).
          </p>

          <h2>Revoking a single connection</h2>
          <p>
            If you just want to disconnect a single social account (e.g. remove Instagram
            access but keep LinkedIn), you can — dashboard UI is coming, and in the meantime
            the same email path works. Mention which platform(s) to revoke.
          </p>

          <h2>Platform-specific notes</h2>
          <p>
            Revoking a connection inside letmepost.dev also deletes our copy of the tokens.
            Some platforms (e.g. Meta, LinkedIn) let you revoke third-party app access from
            their own settings as well. Doing that in both places is the safest path.
          </p>

          <h2>Contact</h2>
          <p><a href="mailto:support@letmepost.dev">support@letmepost.dev</a>. We read every message.</p>
        </div>
      </section>
    </>
  );
}
