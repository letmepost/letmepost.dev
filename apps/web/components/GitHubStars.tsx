"use client";

import { useEffect, useState } from "react";

const REPO = "letmepost/letmepost.dev";
const URL = `https://github.com/${REPO}`;

export function GitHubStars() {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`https://api.github.com/repos/${REPO}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && typeof d.stargazers_count === "number") {
          setStars(d.stargazers_count);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <a
      className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 font-mono text-xs text-mut transition-colors hover:border-acc hover:text-acc"
      href={URL}
      target="_blank"
      rel="noopener"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8 0a8 8 0 00-2.53 15.59c.4.07.55-.17.55-.38v-1.36c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.16-.89-1.16-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.96 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.65 7.65 0 014.01 0c1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.52.56.83 1.28.83 2.15 0 3.08-1.87 3.76-3.65 3.96.29.25.54.74.54 1.49v2.21c0 .22.15.46.55.38A8 8 0 008 0z" />
      </svg>
      Star on GitHub
      {stars !== null && (
        <span
          className="ml-2 border-l border-line pl-2 text-acc tabular-nums"
          aria-label={`${stars} stars`}
        >
          ★ {stars.toLocaleString()}
        </span>
      )}
    </a>
  );
}
