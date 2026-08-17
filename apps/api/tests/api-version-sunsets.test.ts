import { describe, expect, it } from "vitest";
import {
  findExpiringApis,
  PINNED_APIS,
  SUNSET_WARNING_DAYS,
} from "../src/platforms/_shared/api-versions.js";
import { META_GRAPH_VERSION } from "../src/platforms/meta/client.js";
import { LINKEDIN_DEFAULT_VERSION } from "../src/platforms/linkedin/client.js";
import { THREADS_API_VERSION } from "../src/platforms/threads/client.js";

/**
 * The guard. X retired the v1.1 media upload host in June 2025 and it went
 * unnoticed for fourteen months, because nothing failed loudly until a
 * customer's images stopped posting. This test is what makes the next one fail
 * in CI instead.
 */
describe("pinned upstream API versions", () => {
  it("none are within the sunset warning window", () => {
    const expiring = findExpiringApis();
    expect(
      expiring,
      expiring.length === 0
        ? ""
        : `Pinned upstream APIs are near or past their sunset. Bump them and update PINNED_APIS:\n` +
            expiring
              .map(
                (e) =>
                  `  ${e.platform} ${e.version} — ${e.daysRemaining} days left (${e.sunsetOn}) — ${e.source}`,
              )
              .join("\n"),
    ).toEqual([]);
  });

  it("every entry carries a source to re-check the date against", () => {
    for (const api of PINNED_APIS) {
      expect(api.source, `${api.platform} has no source`).toMatch(/^https:\/\//);
    }
  });

  /**
   * The registry is only useful if it describes what the clients actually
   * send. These pin the two together so a version bump that misses the
   * registry (or vice versa) fails here rather than silently drifting.
   */
  it("matches the versions the clients actually send", () => {
    const versionFor = (needle: string) =>
      PINNED_APIS.find((a) => a.platform.includes(needle))?.version;

    expect(versionFor("Meta Graph")).toBe(META_GRAPH_VERSION);
    expect(versionFor("linkedin")).toBe(LINKEDIN_DEFAULT_VERSION);
    expect(versionFor("threads")).toBe(THREADS_API_VERSION);
  });

  it("warns on a date inside the window", () => {
    const soon = new Date("2027-04-01T00:00:00Z");
    const hits = findExpiringApis(soon, SUNSET_WARNING_DAYS);
    expect(hits.map((h) => h.platform)).toContain("linkedin");
  });
});
