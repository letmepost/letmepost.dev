/**
 * Sunset dates for every upstream API version or endpoint we pin.
 *
 * This exists because X retired the v1.1 media upload host in June 2025 and we
 * found out fourteen months later, from a customer, when their images stopped
 * posting. Nothing in the codebase or CI was watching. Text posts kept working
 * the whole time, so no alert fired and no error looked unusual.
 *
 * The guard is `tests/api-version-sunsets.test.ts`: it fails once any entry is
 * inside {@link SUNSET_WARNING_DAYS} of its date, so CI goes red before
 * production does. Entries with a null date have no announced sunset and are
 * here to be reviewed, not to fail the build.
 *
 * Dates are the vendor's published expiry, not a guess. Update them from the
 * linked changelog when bumping a version.
 */

export type PinnedApi = {
  platform: string;
  /** What we pin, as it appears in the client. */
  version: string;
  /** Vendor-published sunset, or null when none is announced. */
  sunsetOn: string | null;
  /** Where the date came from, so the next person can re-check it. */
  source: string;
  notes?: string;
};

/** How close to a sunset the guard starts failing. One quarter's warning. */
export const SUNSET_WARNING_DAYS = 90;

export const PINNED_APIS: readonly PinnedApi[] = [
  {
    platform: "facebook/instagram (Meta Graph)",
    version: "v25.0",
    sunsetOn: "2028-07-29",
    source: "https://developers.facebook.com/docs/graph-api/changelog/versions/",
    notes:
      "Graph versions expire two years after the following release. Bump via META_GRAPH_VERSION.",
  },
  {
    platform: "linkedin",
    version: "202605",
    sunsetOn: "2027-05-01",
    source: "https://learn.microsoft.com/en-us/linkedin/marketing/versioning",
    notes:
      "Monthly YYYYMM releases, supported a minimum of one year. LinkedIn does not fall back to a default: an expired header errors. Bump via LINKEDIN_API_VERSION.",
  },
  {
    platform: "threads",
    version: "v1.0",
    sunsetOn: null,
    source: "https://developers.facebook.com/docs/threads/changelog",
    notes: "v1.0 is still the only version Threads accepts.",
  },
  {
    platform: "twitter",
    version: "v2 (api.twitter.com/2, api.x.com/2 for media)",
    sunsetOn: null,
    source: "https://docs.x.com/changelog",
    notes:
      "v1.1 media upload was retired 2025-06-09; media now goes to /2/media/upload and needs the media.write scope. /2/tweets is still current.",
  },
  {
    platform: "pinterest",
    version: "v5",
    sunsetOn: null,
    source: "https://github.com/pinterest/api-description/releases",
    notes: "v5 is the only supported version; v3 was retired in 2023.",
  },
  {
    platform: "tiktok",
    version: "v2 (Content Posting API)",
    sunsetOn: null,
    source: "https://developers.tiktok.com/doc/changelog",
    notes: "Replaced the Share Video API, retired 2023-09-10.",
  },
  {
    platform: "bluesky",
    version: "app password + com.atproto.server.createSession",
    sunsetOn: null,
    source: "https://docs.bsky.app/blog/oauth-atproto",
    notes:
      "Not deprecated, but Bluesky states OAuth will replace app passwords and createSession over time. Watch for a date.",
  },
];

export type SunsetWarning = {
  platform: string;
  version: string;
  sunsetOn: string;
  daysRemaining: number;
  source: string;
};

/** Entries at or inside the warning window, soonest first. */
export function findExpiringApis(
  now: Date = new Date(),
  withinDays: number = SUNSET_WARNING_DAYS,
): SunsetWarning[] {
  const out: SunsetWarning[] = [];
  for (const api of PINNED_APIS) {
    if (!api.sunsetOn) continue;
    const days = Math.floor(
      (new Date(`${api.sunsetOn}T00:00:00Z`).getTime() - now.getTime()) /
        86_400_000,
    );
    if (days <= withinDays) {
      out.push({
        platform: api.platform,
        version: api.version,
        sunsetOn: api.sunsetOn,
        daysRemaining: days,
        source: api.source,
      });
    }
  }
  return out.sort((a, b) => a.daysRemaining - b.daysRemaining);
}
