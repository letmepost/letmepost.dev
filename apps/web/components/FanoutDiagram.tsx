import type { CSSProperties } from "react";
import { PlatformIcon } from "./PlatformIcon";
import { AgentRotator } from "./agent-rotator";
import { PLATFORMS } from "@/data/platforms";

const order: Record<string, number> = {
  live: 0,
  trial: 0,
  pending: 1,
  planned: 2,
};

export function FanoutDiagram({ mode = "post" }: { mode?: "post" | "agents" }) {
  const seen = new Set<string>();
  const platforms = PLATFORMS.filter((p) =>
    seen.has(p.slug) ? false : (seen.add(p.slug), true),
  ).sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

  const ROW_H = 56;
  const W = 96;
  const H = platforms.length * ROW_H;
  const cy = H / 2;
  const wires = platforms.map((_, i) => {
    const y = i * ROW_H + ROW_H / 2;
    return `M0 ${cy} C ${W * 0.55} ${cy} ${W * 0.45} ${y} ${W} ${y}`;
  });

  const label =
    mode === "agents"
      ? "Fan-out topology: your AI agent publishes to every connected platform through one tool call"
      : "Fan-out topology: one POST to /v1/posts fans out to every connected platform";

  return (
    <figure className="m-0" aria-label={label}>
      <div
        className="grid grid-cols-[132px_96px_1fr] items-center max-[560px]:grid-cols-1"
        style={{ "--row-h": `${ROW_H}px` } as CSSProperties}
      >
        {mode === "agents" ? (
          <AgentRotator />
        ) : (
          <div className="flex flex-col gap-[3px] self-center rounded-xl border-2 border-ink px-[14px] py-[18px] text-center max-[560px]:mb-[18px] max-[560px]:self-stretch">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
              Source
            </span>
            <span className="font-mono text-[18px] font-semibold leading-[1.1] text-acc">
              POST
            </span>
            <span className="font-mono text-[15px] text-ink">/v1/posts</span>
          </div>
        )}

        <svg
          className="block h-full overflow-visible max-[560px]:hidden"
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {wires.map((d, i) => (
            <path
              key={`w${i}`}
              className="fill-none stroke-line [stroke-width:1.5]"
              d={d}
            />
          ))}
          {wires.map((d, i) => (
            <path
              key={`f${i}`}
              className="fill-none stroke-acc opacity-[0.35] [stroke-dasharray:1.5_98.5] [stroke-linecap:round] [stroke-width:1.5] [animation:topo-flow_1.5s_linear_infinite] motion-reduce:animate-none motion-reduce:opacity-0"
              d={d}
              pathLength={100}
              style={{ animationDelay: `${(i * 0.16).toFixed(2)}s` }}
            />
          ))}
        </svg>

        <div className="flex flex-col max-[560px]:border-t max-[560px]:border-line">
          {platforms.map((p) => (
            <div
              className="grid grid-cols-[26px_1fr] items-center gap-3 [height:var(--row-h,56px)] max-[560px]:border-b max-[560px]:border-line"
              key={p.slug}
            >
              <span className="flex items-center justify-center text-ink">
                <PlatformIcon platform={p.slug} size={18} />
              </span>
              <span className="font-mono text-[15px] font-semibold whitespace-nowrap text-ink">
                {p.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}
