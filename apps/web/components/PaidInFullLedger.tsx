const rows: { qty: string; title: string; sub: string; val: string }[] = [
  {
    qty: "1×",
    title: "Multi-target publish endpoint",
    sub: "POST /v1/posts, fans out to every connected account in one call",
    val: "~4 wk",
  },
  {
    qty: "3×",
    title: "Meta App Review absorbed",
    sub: "Instagram + Facebook + Threads, one shared review, our app of record. Three rejections, four re-shot demo videos. Once.",
    val: "~11 wk",
  },
  {
    qty: "1×",
    title: "LinkedIn Marketing Developer Platform review",
    sub: "submitted, version-pinned, sunset-monitored",
    val: "~12 wk",
  },
  {
    qty: "80×",
    title: "Preflight rules",
    sub: "char-count, media-format, audit-state, URN patterns. One docs page each.",
    val: "~6 wk",
  },
  {
    qty: "7×",
    title: "Platform versions pinned for you",
    sub: "we own the LinkedIn-sunsets-every-six-weeks problem",
    val: "∞",
  },
];

export function PaidInFullLedger() {
  return (
    <section className="mx-auto max-w-[1080px] border-t border-line px-16 py-24 max-[1040px]:px-10 max-[860px]:py-16 max-[560px]:px-[22px]">
      <p className="mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint">
        Paid-in-full ledger
      </p>
      <h2 className="mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]">
        Work we did once, so you don&apos;t have to.
      </h2>
      <p className="max-w-[56ch] text-[18px] leading-[1.6] text-mut">
        The integration tax other APIs pass to you, settled up front.
        Here&apos;s the bill we already paid.
      </p>

      <div className="mt-10 border-t border-line">
        {rows.map((r) => (
          <div
            className="grid grid-cols-[56px_1fr_auto] items-baseline gap-5 border-b border-line py-[22px] max-[560px]:grid-cols-[44px_1fr] max-[560px]:gap-y-2"
            key={r.title}
          >
            <span className="font-mono text-sm text-faint tabular-nums">
              {r.qty}
            </span>
            <span className="flex flex-col gap-[5px]">
              <b className="font-disp text-[18px] font-semibold tracking-[-0.01em] text-ink">
                {r.title}
              </b>
              <span className="max-w-[64ch] text-[14.5px] leading-[1.55] text-mut">
                {r.sub}
              </span>
            </span>
            <span className="font-mono text-[15px] font-semibold whitespace-nowrap text-acc tabular-nums max-[560px]:col-start-2">
              {r.val}
            </span>
          </div>
        ))}
        <div className="mt-1 grid grid-cols-[1fr_auto] items-center border-t-2 border-ink pt-6 dark:border-line">
          <span className="font-mono text-xs uppercase tracking-[0.14em] text-faint">
            Time reclaimed
          </span>
          <span className="font-disp text-[30px] font-semibold tracking-[-0.02em] text-acc">
            ≈ 6 months
          </span>
        </div>
      </div>
    </section>
  );
}
