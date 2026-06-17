"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { listPosts, type PostListItem } from "@/lib/posts";
import { queryKeys } from "@/lib/query-keys";
import { useActiveProfile } from "@/lib/profiles";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScheduledPostDrawer } from "@/components/app/scheduled-post-drawer";
import { PLATFORM_BRANDS } from "@/components/app/platform-icons";
import {
  formatStamp,
  relevantStamp,
  statusChipClass,
} from "@/components/app/post-views/shared";
import { cn } from "@/lib/utils";

export default function PostsCalendarPage() {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selected, setSelected] = useState<PostListItem | null>(null);
  const [dayDetail, setDayDetail] = useState<{
    label: string;
    posts: PostListItem[];
  } | null>(null);
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

  function openDay(day: number, posts: PostListItem[]) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth(), day);
    const label = date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    setDayDetail({ label, posts });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
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

      <div className="grid grid-cols-7 text-xs uppercase tracking-wide text-muted-foreground">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-2 px-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 rounded-md ring-1 ring-foreground/10">
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
            <DayCell
              key={key}
              day={day}
              posts={posts}
              isToday={isToday}
              onSelectPost={setSelected}
              onSelectDay={() => openDay(day, posts)}
            />
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

      <DayPostsSheet
        day={dayDetail}
        onOpenChange={(open) => {
          if (!open) setDayDetail(null);
        }}
        onSelectPost={(p) => {
          setDayDetail(null);
          setSelected(p);
        }}
      />

      <ScheduledPostDrawer
        post={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}

const CHIP_HEIGHT_PX = 22;
const MORE_RESERVE_PX = 18;

function DayCell({
  day,
  posts,
  isToday,
  onSelectPost,
  onSelectDay,
}: {
  day: number;
  posts: PostListItem[];
  isToday: boolean;
  onSelectPost: (p: PostListItem) => void;
  onSelectDay: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [maxVisible, setMaxVisible] = useState(3);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      const usable = Math.max(0, height - MORE_RESERVE_PX);
      const fit = Math.max(1, Math.floor(usable / CHIP_HEIGHT_PX));
      setMaxVisible(fit);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const overflowCount = Math.max(0, posts.length - maxVisible);
  const visible =
    overflowCount > 0 ? posts.slice(0, maxVisible) : posts;

  return (
    <div
      className={cn(
        "aspect-square border-b border-r border-foreground/5 p-1.5 flex flex-col gap-1 overflow-hidden",
        isToday && "bg-primary/5",
      )}
    >
      <span
        className={cn(
          "text-xs tabular-nums shrink-0",
          isToday ? "font-semibold text-primary" : "text-muted-foreground",
        )}
      >
        {day}
      </span>
      <div ref={containerRef} className="flex-1 space-y-1 overflow-hidden min-h-0">
        {visible.map((p) => {
          const brand = PLATFORM_BRANDS.find((b) => b.id === p.platform);
          const Icon = brand?.Icon;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelectPost(p)}
              className={cn(
                "flex items-center gap-1 w-full text-left text-[10px] px-1.5 py-0.5 min-w-0",
                "rounded-md ring-1 ring-foreground/10 hover:ring-foreground/30 transition-shadow",
                statusBg(p.status),
              )}
              title={p.text}
            >
              {Icon ? <Icon className="size-3 shrink-0" /> : null}
              <span className="truncate min-w-0">{p.text}</span>
            </button>
          );
        })}
        {overflowCount > 0 ? (
          <button
            type="button"
            onClick={onSelectDay}
            className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            +{overflowCount} more
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DayPostsSheet({
  day,
  onOpenChange,
  onSelectPost,
}: {
  day: { label: string; posts: PostListItem[] } | null;
  onOpenChange: (open: boolean) => void;
  onSelectPost: (p: PostListItem) => void;
}) {
  return (
    <Sheet open={day != null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md flex flex-col p-0">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle>{day?.label ?? "Day"}</SheetTitle>
          <SheetDescription>
            {day?.posts.length ?? 0} posts on this day. Pick one to manage.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto divide-y divide-foreground/5">
          {day?.posts.map((p) => {
            const brand = PLATFORM_BRANDS.find((b) => b.id === p.platform);
            const Icon = brand?.Icon;
            const stamp = relevantStamp(p);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectPost(p)}
                className="w-full flex items-start gap-3 p-3 text-left hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center gap-1.5 shrink-0 w-24">
                  {Icon ? <Icon className="size-4 shrink-0" /> : null}
                  <span className="text-xs font-semibold capitalize">
                    {brand?.label ?? p.platform}
                  </span>
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <p className="text-sm truncate">{p.text}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {stamp.label} {formatStamp(stamp.iso)}
                  </p>
                </div>
                <span className={`shrink-0 ${statusChipClass(p.status)}`}>
                  {p.status}
                </span>
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
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
