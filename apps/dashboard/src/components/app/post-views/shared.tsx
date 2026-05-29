"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listPosts, type PostListItem } from "@/lib/posts";
import { queryKeys } from "@/lib/query-keys";
import { useActiveProfile } from "@/lib/profiles";
import { cn } from "@/lib/utils";

/**
 * Shared data + helpers across /posts, /posts/list, /posts/calendar. Each
 * sub-page imports `usePosts()` here so navigating between views hits the
 * react-query cache instead of refetching, and all three render statuses
 * with the same palette.
 */

export function usePosts() {
  const { activeProfile } = useActiveProfile();
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
  return { query, scheduled, published };
}

export function statusTone(status: PostListItem["status"]): string {
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

export function statusChipClass(status: PostListItem["status"]): string {
  return cn(
    "px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-medium",
    status === "published" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    (status === "queued" || status === "validated") &&
      "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    status === "publishing" && "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    (status === "failed" || status === "rejected") &&
      "bg-destructive/15 text-destructive",
    status === "canceled" && "bg-muted text-muted-foreground line-through",
  );
}

/** Choose the most informative timestamp to surface for a row. */
export function relevantStamp(post: PostListItem): {
  label: "Posted" | "Scheduled for" | "Created";
  iso: string;
} {
  if (post.publishedAt) {
    return { label: "Posted", iso: post.publishedAt };
  }
  if (post.scheduledAt) {
    return { label: "Scheduled for", iso: post.scheduledAt };
  }
  return { label: "Created", iso: post.createdAt };
}

export function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
