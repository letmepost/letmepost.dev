import type { Platform } from "./platforms.js";

/**
 * Per-platform launch state. The single source of truth for "what can a
 * caller do with this platform right now."
 *
 *   - `live`    — Production-ready. OAuth completes, posts publish.
 *   - `trial`   — Connect works, but the upstream is sandboxed or
 *                 rate-capped (Pinterest pre-Standard-Access, X on PPU).
 *   - `pending` — Approval pending. The dashboard greys the tile out and
 *                 the backend rejects connect with `platform_not_enabled`.
 *
 * This module is intentionally zod-free so it can be imported by client
 * bundles (dashboard, marketing site) via the `@letmepost/schemas/platform-state`
 * subpath without pulling zod into the runtime.
 */
export type PlatformState = "live" | "trial" | "pending";

export const PLATFORM_STATES = ["live", "trial", "pending"] as const;

/**
 * Launch config. Move a platform to `live` the moment its review clears.
 * The API layer accepts a `PLATFORM_STATE_OVERRIDES` env to flip a value
 * without a code change (see `apps/api/src/platforms/_shared/platform-state.ts`).
 */
export const PLATFORM_STATE: Record<Platform, PlatformState> = {
  bluesky: "live",
  pinterest: "live",
  twitter: "live",
  linkedin: "live",
  facebook: "live",
  instagram: "live",
  threads: "live",
  tiktok: "pending",
};

export function platformState(p: Platform): PlatformState {
  return PLATFORM_STATE[p];
}

export function isPlatformState(v: unknown): v is PlatformState {
  return (
    typeof v === "string" &&
    (PLATFORM_STATES as readonly string[]).includes(v)
  );
}
