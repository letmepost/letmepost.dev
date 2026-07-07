export type LinkedInVersion = {
  version: string;
  released: string;
  sunset: string;
  notes?: string;
};

const QUARTERLY_MONTHS: ReadonlySet<number> = new Set([1, 4, 7, 10]);
const FIRST_TRACKED_YEAR = 2023;
const FIRST_TRACKED_MONTH = 7;
const SUPPORT_MONTHS = 12;
const HORIZON_MONTHS_AHEAD = 12;

const OVERRIDES: LinkedInVersion[] = [
  {
    version: "202404",
    released: "2024-04-01",
    sunset: "2025-04-01",
    notes:
      "First version cited in our wedge incident — n8n / Zapier / Make / Postiz all broke at sunset.",
  },
  {
    version: "202411",
    released: "2024-11-01",
    sunset: "2025-11-01",
    notes:
      "Off-cadence release. Sunset hit during peak Q4 — most automations failed.",
  },
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function addMonths(
  year: number,
  month: number,
  count: number,
): { year: number; month: number } {
  const totalMonths = year * 12 + (month - 1) + count;
  return {
    year: Math.floor(totalMonths / 12),
    month: (totalMonths % 12) + 1,
  };
}

function compareIso(a: string, b: string): number {
  return a.localeCompare(b);
}

function generateQuarterly(now: Date): LinkedInVersion[] {
  const horizon = addMonths(
    now.getFullYear(),
    now.getMonth() + 1,
    HORIZON_MONTHS_AHEAD,
  );
  const versions: LinkedInVersion[] = [];

  let year = FIRST_TRACKED_YEAR;
  let month = FIRST_TRACKED_MONTH;

  while (
    year < horizon.year ||
    (year === horizon.year && month <= horizon.month)
  ) {
    if (QUARTERLY_MONTHS.has(month)) {
      const sunset = addMonths(year, month, SUPPORT_MONTHS);
      versions.push({
        version: `${year}${pad2(month)}`,
        released: `${year}-${pad2(month)}-01`,
        sunset: `${sunset.year}-${pad2(sunset.month)}-01`,
      });
    }
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  }

  return versions;
}

function build(): LinkedInVersion[] {
  const auto = generateQuarterly(new Date());
  const byVersion = new Map<string, LinkedInVersion>();
  for (const v of auto) byVersion.set(v.version, v);
  for (const v of OVERRIDES) byVersion.set(v.version, v);
  return Array.from(byVersion.values()).sort((a, b) =>
    compareIso(a.released, b.released),
  );
}

export const LINKEDIN_VERSIONS: readonly LinkedInVersion[] = build();

export const LINKEDIN_VERSIONS_GENERATED_AT = new Date().toISOString();
