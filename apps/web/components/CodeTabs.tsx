"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export type CodeTab = { id: string; label: string; file: string; html: string };

export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="mt-9 overflow-hidden rounded-[14px] border border-line bg-code-bg">
      <div className="flex items-center gap-[14px] border-b border-line px-4 py-[11px] font-mono text-xs text-faint">
        <div className="flex gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={cn(
                "cursor-pointer rounded-md border-0 bg-transparent px-[10px] py-1 font-mono text-xs text-faint",
                t.id === active && "bg-acc-soft text-ink",
              )}
              onClick={() => setActive(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="ml-auto">{activeTab?.file}</span>
      </div>
      {tabs.map((t) => (
        <pre
          key={t.id}
          hidden={t.id !== active}
          className="m-0 overflow-x-auto p-[22px] font-mono text-[13px] leading-[1.75] text-code-fg"
          dangerouslySetInnerHTML={{ __html: t.html }}
        />
      ))}
    </div>
  );
}
