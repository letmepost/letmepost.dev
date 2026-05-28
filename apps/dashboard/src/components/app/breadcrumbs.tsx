"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";

/**
 * URL-driven breadcrumb for the dashboard top bar. Segments come from the
 * pathname; label overrides live in the `LABELS` map so nav surfaces read
 * "API keys" instead of "api-keys". Dynamic segments (e.g. ids) are
 * humanized as-is — we deliberately don't look up ids to avoid a fetch on
 * every nav.
 */

const LABELS: Record<string, string> = {
  "": "Dashboard",
  accounts: "Accounts",
  new: "New",
  "api-keys": "API keys",
  webhooks: "Webhooks",
  posts: "Posts",
  logs: "Logs",
  calendar: "Calendar",
  analytics: "Analytics",
  settings: "Settings",
  profiles: "Profiles",
  media: "Media",
};

function labelFor(segment: string): string {
  return (
    LABELS[segment] ??
    segment
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  const crumbs = [
    { href: "/", label: "letmepost.dev" },
    ...segments.map((seg, i) => ({
      href: "/" + segments.slice(0, i + 1).join("/"),
      label: labelFor(seg),
    })),
  ];

  return (
    <nav
      aria-label="Breadcrumb"
      className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0"
    >
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <Fragment key={c.href}>
            {i > 0 ? (
              <span className="text-muted-foreground/50" aria-hidden="true">
                /
              </span>
            ) : null}
            {isLast ? (
              <span className="text-foreground truncate">{c.label}</span>
            ) : (
              <Link
                href={c.href}
                className="hover:text-foreground transition-colors truncate"
              >
                {c.label}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
