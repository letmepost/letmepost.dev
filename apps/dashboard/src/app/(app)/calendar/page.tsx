"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { listPosts, type PostListItem } from "@/lib/posts";
import { queryKeys } from "@/lib/query-keys";
import { useActiveProfile } from "@/lib/profiles";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScheduledPostDrawer } from "@/components/app/scheduled-post-drawer";
import { cn } from "@/lib/utils";

/**
 * Month-grid calendar of scheduled + published posts. The grid is intentionally
 * hand-rolled (no calendar lib) so we keep dependency weight low and the day
 * cells stay easy to style. Each post renders as a chip; click → drawer with
 * the reschedule / cancel actions wired through PATCH/DELETE /v1/posts/:id.
 *
 * Status palette mirrors the Logs page so the same color means the same thing
 * everywhere.
 */
export default function CalendarPage() {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selected, setSelected] = useState<PostListItem | null>(null);
  const { activeProfile } = useActiveProfile();

  const { firstDay, lastDay, leading, days } = useMemo(
    () => buildMonth(cursor),
    [cursor],
  );

  const filters = useMemo(
    () => ({
      after: firstDay.toISOString(),
      before: lastDay.toISOString(),
      limit: 200,
      ...(activeProfile ? { profileId: activeProfile.id } : {}),
    }),
    [firstDay, lastDay, activeProfile],
  );

  const query = useQuery({
    queryKey: queryKeys.posts.list(filters),
    queryFn: () => listPosts(filters),
  });

  const postsByDay = useMemo(() => {
    const map = new Map<string, PostListItem[]>();
    for (const p of query.data?.data ?? []) {
      const when = p.scheduledAt ?? p.publishedAt ?? p.createdAt;
      if (!when) continue;
      const d = new Date(when);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    return map;
  }, [query.data]);

  const monthLabel = cursor.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  function jump(months: number) {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + months, 1));
  }

  return (
    <div className="space-y-4" data-page-wide>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Calendar</h1>
          <p className="text-xs text-muted-foreground">
            Scheduled and published posts on a month grid. Click a chip to
            reschedule or cancel.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => jump(-1)}>
            <CaretLeft className="size-4" />
          </Button>
          <span className="text-sm font-semibold min-w-32 text-center tabular-nums">
            {monthLabel}
          </span>
          <Button variant="ghost" size="icon" onClick={() => jump(1)}>
            <CaretRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const now = new Date();
              setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
            }}
          >
            Today
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 text-xs uppercase tracking-wide text-muted-foreground">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-2 px-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 ring-1 ring-foreground/10">
        {Array.from({ length: leading }).map((_, i) => (
          <div
            key={`lead-${i}`}
            className="aspect-square border-b border-r border-foreground/5 bg-muted/20"
          />
        ))}
        {days.map((day) => {
          const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${day}`;
          const posts = postsByDay.get(key) ?? [];
          const today = new Date();
          const isToday =
            today.getFullYear() === cursor.getFullYear() &&
            today.getMonth() === cursor.getMonth() &&
            today.getDate() === day;
          return (
            <div
              key={key}
              className={cn(
                "aspect-square border-b border-r border-foreground/5 p-1.5 flex flex-col gap-1 overflow-hidden",
                isToday && "bg-primary/5",
              )}
            >
              <span
                className={cn(
                  "text-xs tabular-nums",
                  isToday
                    ? "font-semibold text-primary"
                    : "text-muted-foreground",
                )}
              >
                {day}
              </span>
              <div className="flex-1 space-y-1 overflow-hidden">
                {posts.slice(0, 3).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelected(p)}
                    className={cn(
                      "block w-full text-left text-[10px] truncate px-1.5 py-0.5",
                      "ring-1 ring-foreground/10 hover:ring-foreground/30 transition-shadow",
                      statusBg(p.status),
                    )}
                    title={p.text}
                  >
                    <span className="font-mono uppercase mr-1 opacity-70">
                      {p.platform.slice(0, 2)}
                    </span>
                    {p.text}
                  </button>
                ))}
                {posts.length > 3 ? (
                  <p className="text-[10px] text-muted-foreground">
                    +{posts.length - 3} more
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {query.isLoading ? (
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 21 }).map((_, i) => (
            <Skeleton key={i} className="h-4" />
          ))}
        </div>
      ) : null}

      <ScheduledPostDrawer
        post={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}

function buildMonth(cursor: Date) {
  const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const leading = firstDay.getDay();
  const days = Array.from({ length: lastDay.getDate() }, (_, i) => i + 1);
  return { firstDay, lastDay, leading, days };
}

function statusBg(status: PostListItem["status"]): string {
  switch (status) {
    case "queued":
    case "validated":
      return "bg-amber-500/15 text-amber-900 dark:text-amber-200";
    case "publishing":
      return "bg-blue-500/15 text-blue-900 dark:text-blue-200";
    case "published":
      return "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200";
    case "failed":
    case "rejected":
      return "bg-red-500/15 text-red-900 dark:text-red-200";
    case "canceled":
      return "bg-muted text-muted-foreground line-through";
  }
}
