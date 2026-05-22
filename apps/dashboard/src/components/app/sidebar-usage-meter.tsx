"use client";

import Link from "next/link";
import { isUnlimitedQuota, useSubscription, useUsage } from "@/lib/billing";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Compact monthly-usage meter that lives in the sidebar nav, just above the
 * user-account footer. Polls every 60s (via `useUsage` defaults) and links
 * to /billing on click. Hidden entirely on self-host instances since billing
 * is disabled there.
 *
 * Sidebar collapses to icon-only on small screens; we hide the meter when
 * that happens — there's no useful icon-mode rendering for a percentage.
 */
export function SidebarUsageMeter() {
  const sub = useSubscription();
  const usage = useUsage();

  // Hide entirely on self-host. The hook still fires, but the API responds
  // with `tier: "self_host"` and we render nothing.
  if (sub.data?.tier === "self_host") return null;

  if (sub.isLoading || usage.isLoading) {
    return (
      <div className="px-2 py-2 group-data-[collapsible=icon]:hidden">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-1.5 w-full mt-1.5" />
      </div>
    );
  }

  if (!usage.data || !sub.data) return null;

  const unlimited = isUnlimitedQuota(usage.data.quota);
  const percent = Math.max(0, Math.min(100, usage.data.percent));
  const color =
    percent >= 100
      ? "bg-destructive"
      : percent >= 80
        ? "bg-amber-500"
        : "bg-primary";

  const resetIso = usage.data.resetAt;
  const resetLabel = (() => {
    const d = new Date(resetIso);
    if (Number.isNaN(d.getTime())) return "soon";
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  })();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href="/billing"
            className={cn(
              "block px-2 py-2 mx-1 mb-1",
              "hover:bg-sidebar-accent transition-colors",
              "group-data-[collapsible=icon]:hidden",
            )}
          >
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-sidebar-foreground/70">Posts</span>
              <span className="tabular-nums font-mono">
                {usage.data.postsCount.toLocaleString()}
                <span className="text-sidebar-foreground/50">
                  {" / "}
                  {unlimited ? "∞" : usage.data.quota.toLocaleString()}
                </span>
              </span>
            </div>
            {!unlimited ? (
              <div className="h-1 mt-1.5 bg-sidebar-accent overflow-hidden">
                <div
                  className={cn(
                    "h-full transition-[width]",
                    color,
                  )}
                  style={{ width: `${percent}%` }}
                />
              </div>
            ) : null}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          {unlimited
            ? `Unlimited plan. Resets ${resetLabel} UTC.`
            : `${percent.toFixed(0)}% used. Resets ${resetLabel} UTC.`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
