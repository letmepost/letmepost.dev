"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { buttonClass } from "@/components/ui/button";
import { ClarityBrand } from "./ClarityBrand";

type NavItem = {
  label: string;
  href: string;
  external?: boolean;
  match?: string;
};

const NAV: NavItem[] = [
  { label: "Docs", href: "https://docs.letmepost.dev", external: true },
  { label: "Pricing", href: "/pricing", match: "/pricing" },
  { label: "Platforms", href: "/platforms", match: "/platforms" },
  { label: "APIs", href: "/api/publishing", match: "/api" },
  { label: "Blog", href: "/blog", match: "/blog" },
  { label: "For agents", href: "/agents", match: "/agents" },
];

const DASHBOARD = "https://dashboard.letmepost.dev";
const linkClass = "text-[14.5px] text-mut transition-colors hover:text-ink";

export function ClarityHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isCurrent = (prefix: string) =>
    prefix === "/"
      ? pathname === "/"
      : pathname === prefix || pathname.startsWith(prefix + "/");

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 861px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <>
      <nav className="sticky top-0 z-50 border-b border-line bg-[color-mix(in_srgb,var(--color-bg)_86%,transparent)] backdrop-blur-[10px]">
        <div className="mx-auto flex max-w-[1208px] items-center justify-between gap-[18px] px-16 py-4 max-[1040px]:px-10 max-[560px]:px-[22px]">
          <ClarityBrand size={24} />

          <div className="flex items-center gap-7 max-[860px]:hidden">
            {NAV.map((l) =>
              l.external ? (
                <a key={l.label} href={l.href} className={linkClass}>
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  href={l.href}
                  className={cn(
                    linkClass,
                    isCurrent(l.match!) && "font-semibold text-ink",
                  )}
                >
                  {l.label}
                </Link>
              ),
            )}
          </div>

          <div className="flex items-center gap-3">
            <a
              className={buttonClass({
                variant: "pri",
                className: "max-[560px]:hidden",
              })}
              href={DASHBOARD}
              data-analytics-event="cta.clicked"
              data-analytics-props='{"location":"nav","target":"dashboard","label":"Start for free"}'
            >
              Start for free
            </a>

            <button
              className="hidden h-[38px] w-[38px] items-center justify-center rounded-lg border border-line bg-transparent text-mut transition-colors hover:border-ink hover:text-ink max-[860px]:inline-flex"
              type="button"
              aria-label="Menu"
              aria-expanded={open}
              aria-controls="cl-mobile"
              onClick={() => setOpen((v) => !v)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M2 5h14M2 9h14M2 13h14" />
              </svg>
            </button>
          </div>
        </div>
      </nav>

      <div
        className={cn(
          "border-b border-line bg-bg",
          open ? "block" : "hidden",
        )}
        id="cl-mobile"
      >
        <div className="flex flex-col gap-[2px] px-6 pt-3 pb-[22px]">
          {NAV.map((l) =>
            l.external ? (
              <a
                key={l.label}
                href={l.href}
                className="border-b border-line-soft px-1 py-3 text-base text-ink"
                onClick={() => setOpen(false)}
              >
                {l.label}
              </a>
            ) : (
              <Link
                key={l.label}
                href={l.href}
                className="border-b border-line-soft px-1 py-3 text-base text-ink"
                onClick={() => setOpen(false)}
              >
                {l.label}
              </Link>
            ),
          )}
          <a
            className={buttonClass({ variant: "pri", className: "mt-[14px]" })}
            href={DASHBOARD}
            data-analytics-event="cta.clicked"
            data-analytics-props='{"location":"nav","target":"dashboard","label":"Start for free"}'
          >
            Start for free →
          </a>
        </div>
      </div>
    </>
  );
}
