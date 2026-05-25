"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { isUnlimitedQuota, useSubscription, useUsage } from "@/lib/billing";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Monthly usage meter pinned to the sidebar footer. Polls every 60s via
// useUsage defaults and links to /billing on click. Hidden on self-host
// since billing is disabled there. Hidden in icon-collapsed mode (no
// useful rendering for a percentage at 48px wide).
export function SidebarUsageMeter() {
  const sub = useSubscription();
  const usage = useUsage();

  // Animated count + bar starts from the prior render's value so a 60s
  // refetch tweens to the new number instead of snapping.
  const [animatedCount, setAnimatedCount] = useState(0);
  const [animatedPercent, setAnimatedPercent] = useState(0);

  const targetCount = usage.data?.postsCount ?? 0;
  const targetPercent = Math.max(0, Math.min(100, usage.data?.percent ?? 0));

  useEffect(() => {
    // Briefly defer so the initial paint shows 0, then the CSS transition
    // on the bar plus the framer-motion counter animate to target.
    const t = setTimeout(() => {
      setAnimatedCount(targetCount);
      setAnimatedPercent(targetPercent);
    }, 50);
    return () => clearTimeout(t);
  }, [targetCount, targetPercent]);

  if (sub.data?.tier === "self_host") return null;

  if (sub.isLoading || usage.isLoading) {
    return (
      <div className="px-3 py-3 group-data-[collapsible=icon]:hidden">
        <Skeleton className="h-3 w-16 mb-2" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-1.5 w-full mt-2" />
      </div>
    );
  }

  if (!usage.data || !sub.data) return null;

  const unlimited = isUnlimitedQuota(usage.data.quota);
  const quota = usage.data.quota;
  const tone =
    targetPercent >= 100
      ? "destructive"
      : targetPercent >= 80
        ? "warn"
        : "ok";
  const barColor =
    tone === "destructive"
      ? "bg-destructive"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-primary";

  const resetIso = usage.data.resetAt;
  const resetLabel = (() => {
    const d = new Date(resetIso);
    if (Number.isNaN(d.getTime())) return "soon";
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  })();

  return (
    <Link
      href="/billing"
      className={cn(
        "group/usage relative block px-3 py-3",
        "ring-1 ring-sidebar-border bg-sidebar-accent/30",
        "hover:bg-sidebar-accent transition-colors",
        "group-data-[collapsible=icon]:hidden",
      )}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.08em] text-sidebar-foreground/60">
          Usage
        </span>
        {!unlimited ? (
          <span
            className={cn(
              "text-[10px] tabular-nums font-mono",
              tone === "destructive"
                ? "text-destructive"
                : tone === "warn"
                  ? "text-amber-500"
                  : "text-sidebar-foreground/60",
            )}
          >
            {targetPercent.toFixed(0)}%
          </span>
        ) : null}
      </div>

      <div className="flex items-baseline gap-1.5 mb-2">
        <motion.span
          key={`count-${targetCount}`}
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="text-base font-semibold tabular-nums leading-none"
        >
          {animatedCount.toLocaleString()}
        </motion.span>
        <span className="text-[11px] text-sidebar-foreground/50 leading-none">
          {unlimited || quota === null
            ? "/ ∞"
            : `/ ${quota.toLocaleString()}`}
        </span>
      </div>

      {!unlimited ? (
        <div className="h-1.5 bg-sidebar-border/60 overflow-hidden">
          <motion.div
            className={cn("h-full", barColor)}
            initial={{ width: 0 }}
            animate={{ width: `${animatedPercent}%` }}
            transition={{
              duration: 0.6,
              ease: [0.22, 1, 0.36, 1],
            }}
          />
        </div>
      ) : null}

      <div className="mt-2 text-[10px] text-sidebar-foreground/50">
        Resets {resetLabel}
      </div>
    </Link>
  );
}
