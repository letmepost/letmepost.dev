"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, ArrowSquareOut, Clock } from "@phosphor-icons/react";
import type { PostListItem } from "@/lib/posts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScheduledPostDrawer } from "@/components/app/scheduled-post-drawer";
import { PLATFORM_BRANDS } from "@/components/app/platform-icons";
import {
  formatStamp,
  relevantStamp,
  statusChipClass,
  usePosts,
} from "@/components/app/post-views/shared";

export default function PostsGridPage() {
  const { query, scheduled, published } = usePosts();
  const [selected, setSelected] = useState<PostListItem | null>(null);

  if (query.isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
    );
  }

  if ((query.data?.data.length ?? 0) === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-6">
      {scheduled.length > 0 ? (
        <Section title="Scheduled" count={scheduled.length}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {scheduled.map((p) => (
              <PostCard key={p.id} post={p} onSelect={setSelected} />
            ))}
          </div>
        </Section>
      ) : null}
      {published.length > 0 ? (
        <Section title="Recent" count={published.length}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {published.map((p) => (
              <PostCard key={p.id} post={p} onSelect={setSelected} />
            ))}
          </div>
        </Section>
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

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
        {title} <span className="text-foreground/50">· {count}</span>
      </h2>
      {children}
    </section>
  );
}

function PostCard({
  post,
  onSelect,
}: {
  post: PostListItem;
  onSelect: (p: PostListItem) => void;
}) {
  const editable = post.status === "queued";
  const stamp = relevantStamp(post);
  const brand = PLATFORM_BRANDS.find((b) => b.id === post.platform);
  const Icon = brand?.Icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(post)}
      className="text-left ring-1 ring-foreground/10 hover:ring-foreground/30 transition-shadow p-3 space-y-3 bg-background"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {Icon ? <Icon className="size-4 shrink-0" /> : null}
          <span className="text-xs font-semibold capitalize truncate">
            {brand?.label ?? post.platform}
          </span>
          <span className="text-[11px] text-muted-foreground truncate">
            @{post.account.platformAccountId.slice(0, 14)}
          </span>
        </div>
        <span className={statusChipClass(post.status)}>{post.status}</span>
      </div>
      <p className="text-sm line-clamp-3 leading-relaxed">{post.text}</p>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Clock className="size-3" />
          {stamp.label} {formatStamp(stamp.iso)}
        </span>
        {editable ? (
          <span className="text-primary font-medium">Edit</span>
        ) : (
          <Link
            href={`/logs/${post.id}`}
            onClick={(e) => e.stopPropagation()}
            className="hover:text-foreground inline-flex items-center gap-1"
          >
            Log
            <ArrowSquareOut className="size-3" />
          </Link>
        )}
      </div>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16">
      <div className="size-12 rounded-full bg-muted/60 grid place-items-center mb-4">
        <Plus className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold">No posts yet</h2>
      <p className="text-sm text-muted-foreground max-w-md mt-2">
        Compose your first post and we'll route it to every connected
        account on this profile.
      </p>
      <Button asChild size="sm" className="mt-4">
        <Link href="/posts/new">
          <Plus className="size-4" />
          Create post
        </Link>
      </Button>
    </div>
  );
}
