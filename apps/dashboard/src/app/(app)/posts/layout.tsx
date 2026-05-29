"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  SquaresFour,
  ListBullets,
  CalendarBlank,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * Shared chrome for /posts/* — page title, lead copy, and an in-page tab
 * row that mirrors the sidebar's collapsible Posts group. The sidebar is
 * the canonical entry point (always visible); these tabs are belt-and-
 * braces for users who skim the header.
 *
 * Create Post lives in the sidebar as a top-level CTA — that's why it
 * isn't repeated here.
 */
export default function PostsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const tabs = [
    {
      href: "/posts",
      label: "Grid",
      icon: SquaresFour,
      match: (p: string) => p === "/posts",
    },
    {
      href: "/posts/list",
      label: "List",
      icon: ListBullets,
      match: (p: string) => p === "/posts/list",
    },
    {
      href: "/posts/calendar",
      label: "Calendar",
      icon: CalendarBlank,
      match: (p: string) => p === "/posts/calendar",
    },
  ];

  // /posts/new gets its own chrome (full-bleed composer) — skip the
  // header + tab row entirely.
  if (pathname.startsWith("/posts/new")) {
    return <>{children}</>;
  }

  return (
    <div className="space-y-4" data-page-wide>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold">Posts</h1>
          <p className="text-xs text-muted-foreground">
            Compose, schedule, and review your queued and published content.
          </p>
        </div>
        <div className="flex items-center gap-0.5 p-0.5 bg-muted/40">
          {tabs.map((t) => {
            const active = t.match(pathname);
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 text-xs transition-colors",
                  active
                    ? "bg-background ring-1 ring-foreground/10 font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>
      {children}
    </div>
  );
}
