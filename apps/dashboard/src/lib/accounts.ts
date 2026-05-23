/**
 * Client-side shape mirror of the `/v1/accounts/connect/:platform` contract.
 *
 * The API returns a descriptor the dashboard branches on:
 *   - `kind: "oauth"`      — redirect the browser to `authorizationUrl`
 *   - `kind: "credentials"` — render `fields[]` as a form, POST results to
 *                             `/v1/accounts/connect/:platform/complete`
 *
 * This file intentionally restates the shape rather than importing it from
 * `@letmepost/schemas` — the accounts framework is being built in a parallel
 * worktree and we don't want a cross-package coupling to flap our build.
 */

export type OAuthDescriptor = {
  kind: "oauth";
  authorizationUrl: string;
  state?: string;
};

export type CredentialsField = {
  name: string;
  label: string;
  type?: "text" | "password" | "email";
  required?: boolean;
  placeholder?: string;
  description?: string;
};

export type CredentialsDescriptor = {
  kind: "credentials";
  fields: CredentialsField[];
};

export type ConnectDescriptor = OAuthDescriptor | CredentialsDescriptor;

export type ConnectResponse = {
  platform: string;
  descriptor: ConnectDescriptor;
};

export type Account = {
  id: string;
  platform: string;
  handle?: string;
  displayName?: string;
  createdAt?: string;
  tokenExpiresAt?: string | null;
};

/**
 * Connectable platforms surfaced in the dashboard. Mirrors the Platform enum
 * in @letmepost/schemas; kept local so the dashboard build doesn't pull in
 * schemas' zod transitive. Adding a platform = update both places.
 */
export const CONNECTABLE_PLATFORMS = [
  "bluesky",
  "facebook",
  "instagram",
  "linkedin",
  "pinterest",
  "threads",
  "tiktok",
  "twitter",
] as const;
export type ConnectablePlatform = (typeof CONNECTABLE_PLATFORMS)[number];

// Canonical PLATFORM_STATE comes from the zod-free schemas subpath so
// the dashboard bundle stays clean. `NEXT_PUBLIC_PLATFORM_STATE_OVERRIDES`
// lets us temporarily flip a platform's UI state without a code change —
// e.g. set `facebook:live,instagram:live,threads:live` during Meta App
// Review video recording so the tiles aren't greyed out. Mirrors the API's
// `PLATFORM_STATE_OVERRIDES` parser; the two env vars MUST stay in sync or
// the dashboard will offer a tile the backend rejects.
import {
  PLATFORM_STATE as CANONICAL_STATE,
  type PlatformState,
} from "@letmepost/schemas/platform-state";

export type { PlatformState };

function parseEnvOverrides(
  raw: string | undefined,
): Partial<Record<ConnectablePlatform, PlatformState>> {
  if (!raw) return {};
  const out: Partial<Record<ConnectablePlatform, PlatformState>> = {};
  const validPlatforms = new Set<string>(CONNECTABLE_PLATFORMS);
  const validStates = new Set<string>(["live", "trial", "pending"]);
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [k, v] = trimmed.split(":").map((s) => s.trim());
    if (!k || !v) {
      console.warn(
        `[platform-state] malformed override "${trimmed}" — expected "platform:state".`,
      );
      continue;
    }
    if (!validPlatforms.has(k)) {
      console.warn(
        `[platform-state] unknown platform "${k}" in NEXT_PUBLIC_PLATFORM_STATE_OVERRIDES.`,
      );
      continue;
    }
    if (!validStates.has(v)) {
      console.warn(
        `[platform-state] invalid state "${v}" for ${k}. Valid: live, trial, pending.`,
      );
      continue;
    }
    out[k as ConnectablePlatform] = v as PlatformState;
  }
  return out;
}

const ENV_OVERRIDES = parseEnvOverrides(
  process.env.NEXT_PUBLIC_PLATFORM_STATE_OVERRIDES,
);

export const PLATFORM_STATE: Record<ConnectablePlatform, PlatformState> = {
  ...(CANONICAL_STATE as Record<ConnectablePlatform, PlatformState>),
  ...ENV_OVERRIDES,
};
