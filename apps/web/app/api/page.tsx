import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/lib/icons";
import { buttonClass } from "@/components/ui/button";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { APIS } from "@/data/platforms";

export const metadata: Metadata = {
  title: "API reference: publishing, media, webhooks",
  description:
    "The v1 API surface. Publishing, media uploads, HMAC-signed webhooks. One POST endpoint, eight platforms, idempotency by default.",
  alternates: { canonical: "/api/" },
};

const WRAP =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";
const INL = "rounded bg-acc-soft px-1.5 py-px font-mono text-[0.88em] text-acc";

export default function ApiIndex() {
  return (
    <>
      <header className={`${WRAP} pt-16 pb-2`}>
        <p className="mb-[18px] font-mono text-xs tracking-[0.06em] text-faint [&_a]:text-acc [&_a]:hover:underline">
          <Link href="/">letmepost</Link> / api
        </p>
        <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
          API surface
        </p>
        <h1 className="mb-[26px] max-w-[14ch] font-disp text-[64px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[860px]:text-[46px] max-[560px]:text-[36px]">
          The API surface.
        </h1>
        <p className="max-w-[62ch] text-[21px] leading-[1.55] text-mut [&_b]:font-semibold [&_b]:text-ink">
          <b>Publishing</b> is the heart of it. <b>Media</b> uploads bytes once
          and references them by id. <b>Webhooks</b> push state changes back to
          you. Same auth, same error envelope, same idempotency rules across the
          whole API.
        </p>
        <div className="mt-[30px] flex flex-wrap items-center gap-3">
          <a
            className={buttonClass({ variant: "pri", lg: true })}
            href="https://dashboard.letmepost.dev"
          >
            Get an API key →
          </a>
          <a
            className={buttonClass({ lg: true })}
            href="https://docs.letmepost.dev/api-reference"
          >
            Full reference ↗
          </a>
        </div>
      </header>

      <section className={`${WRAP} pt-10 pb-[72px] max-[860px]:pb-16`}>
        <div className="mt-10 grid grid-cols-3 gap-4 max-[860px]:grid-cols-1">
          {APIS.map((api) => (
            <Link
              className="block rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px] text-inherit transition hover:-translate-y-0.5 hover:border-acc"
              href={`/api/${api.slug}`}
              key={api.slug}
            >
              <div className="grid h-10 w-10 place-items-center rounded-[11px] bg-acc-soft text-acc">
                <Icon icon={`ph:${api.icon}`} width={20} height={20} />
              </div>
              <h3 className="mt-4 mb-[9px] font-disp text-[20px] font-semibold tracking-[-0.01em]">
                {api.name}
              </h3>
              <p className="text-[15px] leading-[1.55] text-mut">{api.pitch}</p>
              <div className="mt-[14px] font-mono text-[11.5px] text-faint">
                {api.detail}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section
        className={`${WRAP} border-t border-line py-24 max-[860px]:py-16`}
      >
        <p className="mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint">
          Consistent by design
        </p>
        <h2 className="mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]">
          One auth, one error shape, one retry contract.
        </h2>
        <p className="max-w-[56ch] text-[18px] leading-[1.6] text-mut">
          Same <code className={INL}>Authorization: Bearer lmp_live_…</code> on
          every call. Same <code className={INL}>Idempotency-Key</code> semantics
          on every write. Same failure envelope (stable code, the rule that
          fired, a remediation hint, and a request id) on every non-2xx. Build
          against one endpoint and the others feel familiar in minutes.
        </p>
        <div className="mt-[26px] flex flex-wrap items-center gap-3">
          <a
            className={buttonClass({ lg: true })}
            href="https://docs.letmepost.dev/api-reference"
          >
            Full reference ↗
          </a>
          <Link className={buttonClass({ lg: true })} href="/platforms">
            Supported platforms →
          </Link>
        </div>
      </section>

      <section className={WRAP}>
        <FinalCta
          title="Make your first call in minutes."
          lede="Free during alpha. No credit card. Grab a key and POST to every connected account in one request."
          actions={
            <>
              <a
                className={finalButtonClass("pri")}
                href="https://dashboard.letmepost.dev"
              >
                Get an API key →
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
