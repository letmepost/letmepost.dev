"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowSquareOut, Clock } from "@phosphor-icons/react";
import type { PostListItem } from "@/lib/posts";
import { Skeleton } from "@/components/ui/skeleton";
import { ScheduledPostDrawer } from "@/components/app/scheduled-post-drawer";
import { PLATFORM_BRANDS } from "@/components/app/platform-icons";
import {
  formatStamp,
  relevantStamp,
  statusChipClass,
  usePosts,
} from "@/components/app/post-views/shared";

export default function PostsListPage() {
  const { query, scheduled, published } = usePosts();
  const [selected, setSelected] = useState<PostListItem | null>(null);

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }

  const all = [...scheduled, ...published];
  if (all.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No posts yet.
      </p>
    );
  }

  return (
    <div className="ring-1 ring-foreground/10 divide-y divide-foreground/5 bg-background">
      {all.map((p) => {
        const brand = PLATFORM_BRANDS.find((b) => b.id === p.platform);
        const Icon = brand?.Icon;
        const stamp = relevantStamp(p);
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p)}
            className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/40 transition-colors"
          >
            <div className="flex items-center gap-2 shrink-0 w-32">
              {Icon ? <Icon className="size-4 shrink-0" /> : null}
              <span className="text-xs font-semibold capitalize">
                {brand?.label ?? p.platform}
              </span>
            </div>
            <span className={`shrink-0 ${statusChipClass(p.status)}`}>
              {p.status}
            </span>
            <span className="flex-1 truncate text-sm">{p.text}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 inline-flex items-center gap-1">
              <Clock className="size-3" />
              {stamp.label} {formatStamp(stamp.iso)}
            </span>
            <Link
              href={`/logs/${p.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0"
            >
              Log
              <ArrowSquareOut className="size-3" />
            </Link>
          </button>
        );
      })}

      <ScheduledPostDrawer
        post={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
