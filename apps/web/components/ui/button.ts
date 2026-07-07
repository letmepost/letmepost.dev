import { cn } from "@/lib/utils";

export function buttonClass(opts?: {
  variant?: "pri" | "ghost";
  lg?: boolean;
  className?: string;
}) {
  const { variant = "ghost", lg = false, className } = opts ?? {};
  return cn(
    "inline-flex cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-lg border border-transparent px-4 py-[9px] font-body text-sm font-semibold transition-colors",
    variant === "pri"
      ? "bg-btn-bg text-btn-fg hover:bg-acc hover:text-white dark:hover:text-[#06281a]"
      : "border-line text-ink hover:border-ink",
    lg && "rounded-[10px] px-6 py-[14px] text-[15.5px]",
    className,
  );
}
