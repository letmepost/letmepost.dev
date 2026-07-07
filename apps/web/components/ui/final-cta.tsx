import type { ReactNode } from "react";

export function FinalCta({
  title,
  lede,
  actions,
}: {
  title: string;
  lede: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="relative isolate mx-[-40px] mt-10 overflow-hidden rounded-[20px] bg-btn-bg p-[72px_56px] text-center max-[860px]:mx-[-20px] max-[860px]:p-[56px_28px] max-[560px]:mx-0 dark:border dark:border-line dark:bg-panel-2">
      <div
        className="pointer-events-none absolute inset-[-60%] z-0 opacity-70 motion-reduce:hidden"
        style={{
          background:
            "conic-gradient(from 0deg, transparent 0deg, var(--color-acc-soft) 70deg, transparent 150deg, transparent 360deg)",
          animation: "final-sheen 16s linear infinite",
        }}
      />
      <div className="relative z-[1]">
        <h2 className="mb-4 font-disp text-[46px] font-semibold tracking-[-0.025em] text-white max-[860px]:text-[34px] dark:text-ink">
          {title}
        </h2>
        <p className="mx-auto mb-[30px] max-w-[48ch] text-[18px] text-white/[0.72] dark:text-mut">
          {lede}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {actions}
        </div>
      </div>
    </div>
  );
}

export function finalButtonClass(variant: "pri" | "ghost") {
  const base =
    "inline-flex cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[10px] border border-transparent px-6 py-[14px] font-body text-[15.5px] font-semibold transition-colors";
  if (variant === "pri") {
    return `${base} bg-acc text-white hover:bg-white hover:text-btn-bg dark:text-[#06281a] dark:hover:bg-acc-ink dark:hover:text-[#06281a]`;
  }
  return `${base} border-white/[0.28] text-white hover:border-white dark:border-line dark:text-ink`;
}
