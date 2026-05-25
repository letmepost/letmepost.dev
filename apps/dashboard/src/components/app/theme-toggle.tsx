"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "@phosphor-icons/react";

import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/button";

const CYCLE: Record<string, string> = {
  light: "dark",
  dark: "system",
  system: "light",
};

// Single-icon theme cycler for the page header. Icon reflects the current
// state (Sun / Moon / Monitor); clicking advances light to dark to system.
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    // Reserve the slot so the header doesn't reflow when next-themes
    // finishes reading localStorage.
    return <div aria-hidden className="size-8" />;
  }

  const current = theme ?? "system";
  const next = CYCLE[current] ?? "system";

  const Icon =
    current === "light" ? Sun : current === "dark" ? Moon : Monitor;
  const label =
    current === "light"
      ? "Switch to dark mode"
      : current === "dark"
        ? "Switch to system theme"
        : "Switch to light mode";

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      aria-label={label}
      title={label}
      onClick={() => {
        track({
          name: "theme.changed",
          properties: { from: current, to: next },
        });
        setTheme(next);
      }}
    >
      <Icon className="size-4" />
    </Button>
  );
}
