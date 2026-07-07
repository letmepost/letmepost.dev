import type { Metadata } from "next";
import Link from "next/link";
import { FanoutDiagram } from "@/components/FanoutDiagram";
import { JsonLd } from "@/components/JsonLd";
import { buttonClass } from "@/components/ui/button";
import { FinalCta, finalButtonClass } from "@/components/ui/final-cta";
import { faqPageSchema } from "@/lib/seo";
import { highlight } from "@/lib/highlight";

export const metadata: Metadata = {
  title: "MCP server for social media publishing",
  description:
    "Native MCP server for social publishing. Claude, Cursor, Claude Code, opencode: any MCP-aware client drives the entire letmepost API through 21 OpenAPI-generated tools. OAuth 2.1 with Dynamic Client Registration (RFC 7591). Apache 2.0 source.",
  alternates: { canonical: "/agents/" },
};

const faqs = [
  {
    q: "What does my agent need to know about MCP?",
    a: "Nothing letmepost-specific. If your client speaks MCP, it can talk to us. Add the install line, restart the client, and the tools appear in the model's tool surface automatically.",
  },
  {
    q: "API key vs OAuth, which should my agent use?",
    a: "API key for local development and CI. OAuth 2.1 + DCR for production agents that should not embed a long-lived shared secret. Both work over the same MCP endpoints.",
  },
  {
    q: "What happens if my agent retries a posts.create call?",
    a: 'If the same idempotency key was used, the cached response comes back (within 24h). No double-post. If a different idempotency key was used, you get an <code class="inl">idempotency_conflict</code> response (HTTP 409).',
  },
  {
    q: "Can my agent self-host the MCP server?",
    a: 'Yes. The MCP server is part of the open-source Docker image. <code class="inl">docker compose up</code> runs it locally on port 4001. Same tool surface, your platform credentials.',
  },
  {
    q: "What about audit logs?",
    a: "Every tool call is logged with the agent's client_id (for OAuth) or last-4 of the API key. Visible in the dashboard. 30-day retention on Pro, 180 on Business.",
  },
  {
    q: "Where do I report bugs in the MCP server?",
    a: 'Open an issue on <a href="https://github.com/letmepost/letmepost.dev">the repo</a> and tag it <code class="inl">mcp</code>. We respond within 24h on weekdays during alpha.',
  },
];

const tools: [string, string][] = [
  ["posts.create", "Publish or schedule across one or many platforms"],
  ["posts.validate", "Run preflight without sending"],
  ["posts.get", "Fetch a post and its per-target outcomes"],
  ["posts.reschedule", "Move a queued post's scheduledAt"],
  ["posts.cancel", "Cancel before the worker picks it up"],
  ["media.upload", "Upload bytes, get a reusable mediaId"],
  ["accounts.connect", "Start an OAuth connect flow for a platform"],
  ["accounts.list", "List connected accounts and their pinned versions"],
  ["webhooks.create", "Register an HMAC-signed endpoint"],
  ["platforms.status", "Live / pending state per platform"],
  ["quota.get", "Current usage against the org's cap"],
  ["versions.list", "Pinned upstream API versions + upcoming sunsets"],
];

const mcpConfig = `{
  "mcpServers": {
    "letmepost": {
      "command": "npx",
      "args":    ["@letmepost/mcp@latest"],
      "env":     { "LMP_API_KEY": "lmp_live_…" }
    }
  }
}`;

const cliSample = `npm i -g @letmepost/cli
lmp posts create --target bluesky --target x \\
  --text "Shipped multi-target publishing today."
# → req_01HXY… · bluesky published · x published`;

const jsonLd = [faqPageSchema(faqs)];

const wrap =
  "mx-auto max-w-[1080px] px-16 max-[1040px]:px-10 max-[560px]:px-[22px]";
const kicker =
  "mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint";
const h2 =
  "mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]";
const lead = "max-w-[56ch] text-[18px] leading-[1.6] text-mut";

export default function Agents() {
  return (
    <>
      <JsonLd graphs={jsonLd} />

      <header className={`${wrap} pt-16 pb-2`}>
        <div className="grid grid-cols-2 items-center gap-[52px] max-[980px]:grid-cols-1 max-[980px]:gap-9">
          <div>
            <p className="mb-[22px] font-mono text-xs uppercase tracking-[0.18em] text-acc">
              For agents
            </p>
            <h1 className="mb-[26px] max-w-[14ch] font-disp text-[52px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance max-[980px]:max-w-none max-[980px]:text-[42px] max-[560px]:text-[32px]">
              letmepost speaks <span className="text-acc">MCP</span> natively.
            </h1>
            <p className="max-w-[46ch] text-[21px] leading-[1.55] text-mut max-[980px]:max-w-none">
              One install line. Twenty-one MCP tools. Your agent publishes to
              eight social platforms (text, image, video, scheduled, replied,
              quoted) without you shipping a per-platform SDK. OAuth 2.1 with
              Dynamic Client Registration, so the agent registers itself.
            </p>
            <div className="mt-[30px] flex flex-wrap items-center gap-3">
              <a
                className={buttonClass({ variant: "pri", lg: true })}
                href="https://docs.letmepost.dev/agents/mcp"
                data-analytics-event="docs.link_clicked"
                data-analytics-props='{"from_page":"agents","to_section":"mcp"}'
              >
                Read MCP docs →
              </a>
              <a
                className={buttonClass({ lg: true })}
                href="https://github.com/letmepost/letmepost.dev"
                target="_blank"
                rel="noopener"
                data-analytics-event="external.github_clicked"
                data-analytics-props='{"from_page":"agents","location":"agents-hero"}'
              >
                GitHub ↗
              </a>
            </div>
          </div>
          <div>
            <FanoutDiagram mode="agents" />
          </div>
        </div>
      </header>

      <section className={`${wrap} pt-10 pb-[72px] max-[860px]:pb-16`}>
        <div className="mt-9 overflow-hidden rounded-[14px] border border-line bg-code-bg">
          <div className="flex items-center gap-[14px] border-b border-line px-4 py-[11px] font-mono text-xs text-faint">
            <span className="flex gap-[7px]">
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
            </span>
            <span className="ml-auto">~/.config/mcp.json</span>
          </div>
          <pre
            className="m-0 overflow-x-auto p-[22px] font-mono text-[13px] leading-[1.75] text-code-fg"
            dangerouslySetInnerHTML={{ __html: highlight("json", mcpConfig) }}
          />
        </div>
        <div className="mt-[22px] flex flex-wrap gap-[10px]">
          <span className="rounded-full border border-line px-[14px] py-[7px] font-mono text-[12.5px] text-mut">
            Claude
          </span>
          <span className="rounded-full border border-line px-[14px] py-[7px] font-mono text-[12.5px] text-mut">
            Cursor
          </span>
          <span className="rounded-full border border-line px-[14px] py-[7px] font-mono text-[12.5px] text-mut">
            Claude Code
          </span>
          <span className="rounded-full border border-line px-[14px] py-[7px] font-mono text-[12.5px] text-mut">
            opencode
          </span>
          <span className="rounded-full border border-line px-[14px] py-[7px] font-mono text-[12.5px] text-mut">
            any MCP client
          </span>
        </div>
      </section>

      <section className={`${wrap} border-t border-line py-24 max-[860px]:py-16`}>
        <p className={kicker}>Two ways in</p>
        <h2 className={h2}>Hosted, or in your own process.</h2>
        <div className="mt-10 grid grid-cols-2 gap-4 max-[860px]:grid-cols-1">
          <div className="rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px]">
            <h3 className="mt-4 mb-[9px] font-disp text-[20px] font-semibold tracking-[-0.01em]">
              Hosted server
            </h3>
            <p className="text-[15px] leading-[1.55] text-mut">
              <code className="rounded bg-acc-soft px-1.5 py-px font-mono text-[0.88em] text-acc">
                api.letmepost.dev/mcp
              </code>
              . Streamable HTTP, stateless, OAuth 2.1 with dynamic client
              registration. Nothing to run: point your client at the URL and
              authenticate.
            </p>
            <div className="mt-[14px] font-mono text-[11.5px] text-faint">
              streamable http · oauth 2.1 + dcr
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-panel px-7 pt-7 pb-[30px]">
            <h3 className="mt-4 mb-[9px] font-disp text-[20px] font-semibold tracking-[-0.01em]">
              stdio binary
            </h3>
            <p className="text-[15px] leading-[1.55] text-mut">
              <code className="rounded bg-acc-soft px-1.5 py-px font-mono text-[0.88em] text-acc">
                npx @letmepost/mcp@latest
              </code>
              . Runs in-process next to your agent for local-first or air-gapped
              setups. Same 21 tools, same auth as the HTTP API.
            </p>
            <div className="mt-[14px] font-mono text-[11.5px] text-faint">
              npm · stdio transport
            </div>
          </div>
        </div>
      </section>

      <section className={`${wrap} py-24 max-[860px]:py-16`}>
        <p className={kicker}>The tool surface</p>
        <h2 className={h2}>Twenty-one tools, generated from OpenAPI.</h2>
        <p className={lead}>
          The MCP surface is generated from the same OpenAPI spec as the SDKs at
          startup, so it never drifts from the HTTP API. A representative slice:
        </p>
        <div className="mt-9 grid grid-cols-3 gap-px overflow-hidden rounded-[14px] border border-line bg-line max-[860px]:grid-cols-2 max-[560px]:grid-cols-1">
          {tools.map(([name, desc]) => {
            const [ns, method] = name.split(".");
            return (
              <div className="bg-panel px-[18px] py-4" key={name}>
                <div className="font-mono text-[13px] text-ink">
                  <span className="text-acc">{ns}.</span>
                  {method}
                </div>
                <div className="mt-[5px] text-[12.5px] leading-[1.4] text-mut">
                  {desc}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className={`${wrap} border-t border-line py-24 max-[860px]:py-16`}>
        <p className={kicker}>Prefer a shell?</p>
        <h2 className={h2}>There&apos;s a CLI too.</h2>
        <p className={lead}>Same auth, same surface, scriptable in CI.</p>
        <div className="mt-6 overflow-hidden rounded-[14px] border border-line bg-code-bg">
          <div className="flex items-center gap-[14px] border-b border-line px-4 py-[11px] font-mono text-xs text-faint">
            <span className="flex gap-[7px]">
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
              <i className="inline-block h-[10px] w-[10px] rounded-full bg-line" />
            </span>
            <span className="ml-auto">terminal</span>
          </div>
          <pre
            className="m-0 overflow-x-auto p-[22px] font-mono text-[13px] leading-[1.75] text-code-fg"
            dangerouslySetInnerHTML={{ __html: highlight("bash", cliSample) }}
          />
        </div>
      </section>

      <section className={`${wrap} py-[72px] max-[860px]:py-16`}>
        <p className={kicker}>Fine print, agents</p>
        <h2 className={h2}>Questions an agent-builder would ask.</h2>
        <div className="mt-9 border-t border-line">
          {faqs.map((f) => (
            <div className="border-b border-line py-6" key={f.q}>
              <p className="mb-2 font-disp text-[18px] font-semibold">{f.q}</p>
              <p
                className="m-0 max-w-[70ch] text-[15.5px] leading-[1.6] text-mut [&_a]:text-acc [&_code]:rounded [&_code]:bg-acc-soft [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:text-acc"
                dangerouslySetInnerHTML={{ __html: f.a }}
              />
            </div>
          ))}
        </div>
      </section>

      <section className={wrap}>
        <FinalCta
          title="Give your agent a publishing primitive."
          lede="Free during alpha. No credit card. Wire up the MCP server and your agent posts everywhere in one tool call."
          actions={
            <>
              <a
                className={finalButtonClass("pri")}
                href="https://dashboard.letmepost.dev"
              >
                Get an API key →
              </a>
              <Link className={finalButtonClass("ghost")} href="/api/publishing">
                See the Publishing API
              </Link>
            </>
          }
        />
      </section>
    </>
  );
}
