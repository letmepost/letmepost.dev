"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/icons";

const AGENTS = [
  { icon: "simple-icons:claude", name: "Claude" },
  { icon: "simple-icons:openai", name: "ChatGPT" },
  { icon: "simple-icons:cursor", name: "Cursor" },
  { icon: "simple-icons:zedindustries", name: "Zed" },
];

export function AgentRotator() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(
      () => setActive((i) => (i + 1) % AGENTS.length),
      2000,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-2 self-center rounded-xl border-2 border-ink px-[14px] py-[18px] text-center max-[560px]:mb-[18px] max-[560px]:self-stretch">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        Your agent
      </span>
      <span className="relative flex h-[26px] items-center justify-center">
        {AGENTS.map((a, i) => (
          <span
            key={a.name}
            className={cn(
              "absolute inset-0 inline-flex items-center justify-center gap-2 whitespace-nowrap font-mono text-[16px] font-semibold text-ink transition-opacity duration-[320ms] [&_svg]:text-acc",
              i === active ? "opacity-100" : "opacity-0",
            )}
          >
            <Icon icon={a.icon} width={18} height={18} />
            {a.name}
          </span>
        ))}
      </span>
    </div>
  );
}
