"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Plus,
  SquaresFour,
  ListBullets,
  CalendarBlank,
  ArrowSquareOut,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { listPosts, type PostListItem } from "@/lib/posts";
import { queryKeys } from "@/lib/query-keys";
import { useActiveProfile } from "@/lib/profiles";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScheduledPostDrawer } from "@/components/app/scheduled-post-drawer";
import { ComposePostModal } from "@/components/app/compose-post-modal";
import { cn } from "@/lib/utils";

/**
 * /posts — the management surface for scheduled + published content.
 *
 * Differs from /logs:
 *   - /posts is forward-looking ("what's coming up?") with a Create CTA
 *   - /logs is backward-looking ("did my post land?") with status filtering
 *
 * View toggle:
 *   - grid (cards, the default)
 *   - list (compact table — same data, dense)
 *   - calendar (routes to /calendar)
 */
type View = "grid" | "list";

export default function PostsPage() {
  const { activeProfile } = useActiveProfile();
  const [view, setView] = useState<View>("grid");
  const [composeOpen, setComposeOpen] = useState(false);
  const [selected, setSelected] = useState<PostListItem | null>(null);

  const filters = useMemo(
    () => ({
      limit: 100,
      ...(activeProfile ? { profileId: activeProfile.id } : {}),
    }),
    [activeProfile],
  );

  const query = useQuery({
    queryKey: queryKeys.posts.list(filters),
    queryFn: () => listPosts(filters),
  });

  // Bucket the data so the grid view can group "Scheduled" above "Published",
  // matching Zernio's "Scheduled (new)" sort default.
  const { scheduled, published } = useMemo(() => {
    const all = query.data?.data ?? [];
    const now = Date.now();
    const sched: PostListItem[] = [];
    const pub: PostListItem[] = [];
    for (const p of all) {
      if (
        p.status === "queued" &&
        p.scheduledAt &&
        new Date(p.scheduledAt).getTime() > now
      ) {
        sched.push(p);
      } else {
        pub.push(p);
      }
    }
    sched.sort(
      (a, b) =>
        new Date(a.scheduledAt!).getTime() -
        new Date(b.scheduledAt!).getTime(),
    );
    return { scheduled: sched, published: pub };
  }, [query.data]);

  return (
    <div className="space-y-4" data-page-wide>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Posts</h1>
          <p className="text-xs text-muted-foreground">
            Compose, schedule, and review your queued and published content.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 p-0.5 bg-muted/40">
            <ViewBtn
              active={view === "grid"}
              onClick={() => setView("grid")}
              icon={<SquaresFour className="size-3.5" />}
              label="Grid"
            />
            <ViewBtn
              active={view === "list"}
              onClick={() => setView("list")}
              icon={<ListBullets className="size-3.5" />}
              label="List"
            />
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 gap-1.5"
            >
              <Link href="/calendar">
                <CalendarBlank className="size-3.5" />
                <span className="text-xs">Calendar</span>
              </Link>
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            <ArrowsClockwise
              className={cn(
                "size-3.5",
                query.isFetching && "animate-spin",
              )}
            />
          </Button>
          <Button size="sm" onClick={() => setComposeOpen(true)}>
            <Plus className="size-4" />
            Create post
          </Button>
        </div>
      </div>

      {query.isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (query.data?.data.length ?? 0) === 0 ? (
        <EmptyState onCompose={() => setComposeOpen(true)} />
      ) : view === "grid" ? (
        <GridView
          scheduled={scheduled}
          published={published}
          onSelect={setSelected}
        />
      ) : (
        <ListView
          scheduled={scheduled}
          published={published}
          onSelect={setSelected}
        />
      )}

      <ComposePostModal
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSuccess={() => query.refetch()}
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

function ViewBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 h-7 px-2.5 text-xs transition-colors",
        active
          ? "bg-background ring-1 ring-foreground/10 font-semibold"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function GridView({
  scheduled,
  published,
  onSelect,
}: {
  scheduled: PostListItem[];
  published: PostListItem[];
  onSelect: (p: PostListItem) => void;
}) {
  return (
    <div className="space-y-6">
      {scheduled.length > 0 ? (
        <Section title="Scheduled" count={scheduled.length}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {scheduled.map((p) => (
              <PostCard key={p.id} post={p} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      ) : null}
      {published.length > 0 ? (
        <Section title="Recent" count={published.length}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {published.map((p) => (
              <PostCard key={p.id} post={p} onSelect={onSelect} />
            ))}
          </div>
        </Section>
      ) : null}
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
  const when =
    post.scheduledAt ?? post.publishedAt ?? post.createdAt;
  const editable = post.status === "queued";
  return (
    <button
      type="button"
      onClick={() => onSelect(post)}
      className="text-left ring-1 ring-foreground/10 hover:ring-foreground/30 transition-shadow p-3 space-y-2 bg-background"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="uppercase tracking-wide">
          {post.platform}
        </Badge>
        <span className={cn("text-[10px]", statusTone(post.status))}>
          {post.status}
        </span>
      </div>
      <p className="text-sm line-clamp-3">{post.text}</p>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="tabular-nums">{formatStamp(when)}</span>
        {editable ? (
          <span className="text-primary">Edit</span>
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

function ListView({
  scheduled,
  published,
  onSelect,
}: {
  scheduled: PostListItem[];
  published: PostListItem[];
  onSelect: (p: PostListItem) => void;
}) {
  const all = [...scheduled, ...published];
  return (
    <div className="ring-1 ring-foreground/10 divide-y divide-foreground/5">
      {all.map((p) => {
        const when = p.scheduledAt ?? p.publishedAt ?? p.createdAt;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p)}
            className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/40 transition-colors"
          >
            <Badge variant="outline" className="uppercase tracking-wide shrink-0">
              {p.platform}
            </Badge>
            <span className={cn("text-[10px] shrink-0 w-20", statusTone(p.status))}>
              {p.status}
            </span>
            <span className="flex-1 truncate text-sm">{p.text}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
              {formatStamp(when)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ onCompose }: { onCompose: () => void }) {
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
      <Button size="sm" className="mt-4" onClick={onCompose}>
        <Plus className="size-4" />
        Create post
      </Button>
    </div>
  );
}

function statusTone(status: PostListItem["status"]): string {
  switch (status) {
    case "published":
      return "text-emerald-600 dark:text-emerald-400";
    case "queued":
    case "validated":
      return "text-amber-600 dark:text-amber-400";
    case "publishing":
      return "text-blue-600 dark:text-blue-400";
    case "failed":
    case "rejected":
      return "text-destructive";
    case "canceled":
      return "text-muted-foreground line-through";
  }
}

function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
