"use client";

import { useState } from "react";
import {
  BLUESKY_MAX_GRAPHEMES,
  FACEBOOK_MAX_GRAPHEMES,
  INSTAGRAM_MAX_GRAPHEMES,
  LINKEDIN_MAX_GRAPHEMES,
  THREADS_MAX_GRAPHEMES,
  TIKTOK_MAX_CAPTION_CHARS,
  TWITTER_MAX_GRAPHEMES,
} from "@letmepost/schemas";
import { cn } from "@/lib/utils";

const limits = {
  bluesky: BLUESKY_MAX_GRAPHEMES,
  twitter: TWITTER_MAX_GRAPHEMES,
  threads: THREADS_MAX_GRAPHEMES,
  instagram: INSTAGRAM_MAX_GRAPHEMES,
  tiktok: TIKTOK_MAX_CAPTION_CHARS,
  linkedin: LINKEDIN_MAX_GRAPHEMES,
  facebook: FACEBOOK_MAX_GRAPHEMES,
} as const;

type DemoPlatform = keyof typeof limits;
type EnvelopeFieldValue = string | number | boolean;
type ErrorEnvelopeShape = { error: Record<string, EnvelopeFieldValue> };
type SuccessEnvelope = Record<string, EnvelopeFieldValue>;
type DemoEnvelope = ErrorEnvelopeShape | SuccessEnvelope;

const PLATFORMS: { slug: DemoPlatform; label: string }[] = [
  { slug: "bluesky", label: "Bluesky" },
  { slug: "twitter", label: "X / Twitter" },
  { slug: "threads", label: "Threads" },
  { slug: "instagram", label: "Instagram" },
  { slug: "tiktok", label: "TikTok" },
  { slug: "linkedin", label: "LinkedIn" },
  { slug: "facebook", label: "Facebook" },
];

const platformNames: Record<DemoPlatform, string> = {
  bluesky: "Bluesky",
  twitter: "X / Twitter",
  threads: "Threads",
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

const platformVersions: Record<DemoPlatform, string> = {
  bluesky: "atproto-2026-04",
  twitter: "v2",
  threads: "Graph API v1.0",
  instagram: "Graph API",
  tiktok: "v2",
  linkedin: "202605",
  facebook: "Graph API",
};

const demoFailureText =
  "A launch note that keeps going past the smallest supported post limit so the failure envelope is visible immediately. letmepost checks the text before a platform call, names the exact rule that fired, returns a remediation, and keeps request identifiers attached for support, so a 2 a.m. page becomes a one-line fix instead of a guessing game about which of eight platforms rejected you.";

function countGraphemes(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(
      new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text),
    ).length;
  }
  return Array.from(text).length;
}

function buildPassedEnvelope(
  platform: DemoPlatform,
  graphemes: number,
  limit: number,
): SuccessEnvelope {
  return {
    ok: true,
    platform,
    platform_version: platformVersions[platform],
    graphemes,
    max_graphemes: limit,
    message: `${platformNames[platform]} text is within the published grapheme limit.`,
  };
}

function buildFailedEnvelope(
  platform: DemoPlatform,
  graphemes: number,
  limit: number,
): ErrorEnvelopeShape {
  return {
    error: {
      code: "preflight_failed",
      rule: `${platform}.text.max_graphemes`,
      platform,
      platform_version: platformVersions[platform],
      message: `Text is ${graphemes} graphemes; ${platformNames[platform]} allows at most ${limit}.`,
      remediation: `Trim the text to ${limit} graphemes or fewer.`,
      doc_url: "https://docs.letmepost.dev/errors/preflight_failed",
      rule_url: `https://docs.letmepost.dev/preflight/${platform}-text-max_graphemes`,
      request_id: "req_01HXY7Z8K9MNB1P2QR3STVW",
      trace_id: "01jb7q9c4e5f6g7h8i9k0lm1np",
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char] ?? char;
  });
}

function highlightJson(json: string): string {
  return escapeHtml(json).replace(
    /(&quot;(?:\\.|[^\\])*?&quot;)(\s*:)?|\b(true|false)\b|\b\d+\b/g,
    (match, stringValue, colon) => {
      if (stringValue && colon)
        return `<span class="json-key">${stringValue}</span>${colon}`;
      if (
        stringValue &&
        (stringValue.includes("preflight_failed") ||
          stringValue.includes(".text.max_graphemes"))
      ) {
        return `<span class="json-accent">${stringValue}</span>`;
      }
      if (stringValue) return `<span class="json-string">${stringValue}</span>`;
      if (match === "true" || match === "false")
        return `<span class="json-boolean">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    },
  );
}

export function ErrorEnvelope() {
  const [platform, setPlatform] = useState<DemoPlatform>("bluesky");
  const [text, setText] = useState(demoFailureText);

  const graphemes = countGraphemes(text);
  const limit = limits[platform];
  const envelope: DemoEnvelope =
    graphemes > limit
      ? buildFailedEnvelope(platform, graphemes, limit)
      : buildPassedEnvelope(platform, graphemes, limit);
  const isError = "error" in envelope;
  const html = highlightJson(JSON.stringify(envelope, null, 2));

  return (
    <section className="mx-auto max-w-[1080px] border-t border-line px-16 py-24 max-[1040px]:px-10 max-[860px]:py-16 max-[560px]:px-[22px]">
      <p className="mb-[14px] font-mono text-xs uppercase tracking-[0.16em] text-faint">
        Anatomy of a failure
      </p>
      <h2 className="mb-4 max-w-[20ch] font-disp text-[38px] font-semibold leading-[1.1] tracking-[-0.02em] text-balance max-[860px]:text-[31px]">
        Structured every time. No empty 500s.
      </h2>
      <p className="max-w-[56ch] text-[18px] leading-[1.6] text-mut">
        When a request would break a platform&apos;s rules, letmepost rejects it
        locally with the exact rule that fired, the pinned platform version, and
        how to fix it.
      </p>

      <div className="mt-[34px] grid grid-cols-2 gap-7 max-[900px]:grid-cols-1">
        <form
          className="overflow-hidden rounded-[18px] border border-line bg-panel"
          onSubmit={(e) => e.preventDefault()}
        >
          <div className="flex min-h-[56px] items-center justify-between border-b border-line px-[18px] font-mono text-sm">
            <span className="font-bold text-acc">POST</span>
            <span className="text-faint">/v1/preflight</span>
          </div>

          <div className="px-[18px] pt-[26px] pb-6">
            <div className="mb-7 grid gap-[14px]">
              <span className="font-mono text-[13px] uppercase tracking-[0.12em] text-faint">
                Platform
              </span>
              <div className="flex flex-wrap gap-[10px]" role="group" aria-label="Platform">
                {PLATFORMS.map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    className={cn(
                      "cursor-pointer rounded-full border px-4 py-[10px] font-mono text-sm transition-colors",
                      p.slug === platform
                        ? "border-btn-bg bg-btn-bg text-btn-fg"
                        : "border-line bg-transparent text-mut hover:border-mut hover:text-ink",
                    )}
                    aria-pressed={p.slug === platform}
                    onClick={() => setPlatform(p.slug)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="grid gap-[14px]">
              <span className="font-mono text-[13px] uppercase tracking-[0.12em] text-faint">
                Post text
              </span>
              <textarea
                rows={7}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-[190px] w-full resize-y rounded-xl border border-line bg-panel p-[18px] font-mono text-sm leading-[1.65] text-ink"
              />
            </label>
          </div>
        </form>

        <div className="overflow-hidden rounded-[18px] border border-line bg-panel">
          <div
            className={cn(
              "flex min-h-[56px] items-center justify-between border-b border-line px-[18px] font-mono text-sm font-bold",
              isError ? "text-[#c7352c]" : "text-acc",
            )}
          >
            <span className="inline-flex items-center gap-[10px]">
              <span className="inline-block h-2 w-2 rounded-full bg-current" />
              <span>{isError ? "422" : "200"}</span>
            </span>
            <span className="text-faint">response</span>
          </div>

          <pre
            className="m-0 min-h-[360px] overflow-x-auto p-[18px_22px_28px] font-mono text-[13px] leading-[1.65] whitespace-pre-wrap text-ink"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </section>
  );
}
