import {
  PLATFORM_STATE as DEFAULT_STATE,
  isPlatformState,
} from "@letmepost/schemas/platform-state";
import type { Platform, PlatformState } from "@letmepost/schemas";
import { LetmepostError } from "../../errors.js";

/**
 * Resolve a platform's launch state with an env-override layer so a
 * platform can flip live by setting `PLATFORM_STATE_OVERRIDES` and
 * restarting the process. Defaults live in `@letmepost/schemas`.
 *
 *   PLATFORM_STATE_OVERRIDES=pinterest:live,linkedin:trial
 *
 * Invalid tokens (bad key, bad value, malformed pair) throw at parse
 * time so a typo in a deploy config doesn't silently leave a platform
 * in its default state. The `validate-once` semantics live inside
 * `parseOverrides`; the resolver re-reads env on every call so tests
 * that mutate `process.env` see the change without a cache reset.
 */
function parseOverrides(raw: string | undefined): Partial<Record<Platform, PlatformState>> {
  if (!raw) return {};
  const out: Partial<Record<Platform, PlatformState>> = {};
  const validPlatforms = new Set(Object.keys(DEFAULT_STATE));
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [k, v] = trimmed.split(":").map((s) => s.trim());
    if (!k || !v) {
      throw new Error(
        `PLATFORM_STATE_OVERRIDES: malformed entry "${trimmed}" — expected "platform:state".`,
      );
    }
    if (!validPlatforms.has(k)) {
      throw new Error(
        `PLATFORM_STATE_OVERRIDES: unknown platform "${k}". Valid: ${Array.from(validPlatforms).join(", ")}.`,
      );
    }
    if (!isPlatformState(v)) {
      throw new Error(
        `PLATFORM_STATE_OVERRIDES: invalid state "${v}" for ${k}. Valid: live, trial, pending.`,
      );
    }
    out[k as Platform] = v;
  }
  return out;
}

export function platformState(p: Platform): PlatformState {
  const overrides = parseOverrides(process.env.PLATFORM_STATE_OVERRIDES);
  return overrides[p] ?? DEFAULT_STATE[p];
}

export function assertPlatformEnabled(platform: Platform): void {
  const state = platformState(platform);
  if (state === "pending") {
    throw new LetmepostError({
      code: "platform_not_enabled",
      status: 403,
      message: `${platform} is pending platform approval and not yet connectable.`,
      platform,
      remediation:
        "Subscribe to changelog updates for launch notifications, or self-host with your own platform credentials.",
    });
  }
}

