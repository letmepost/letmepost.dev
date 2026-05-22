/**
 * Canonical per-tier limits. The quota is monthly post count; log retention
 * is how long published / failed posts stay in the post log before the
 * nightly cleanup job deletes them.
 *
 * `Infinity` means uncapped. The quota gate skips the increment query
 * entirely when the resolved quota is Infinity, so self-hosters never even
 * touch billing_usage.
 */
export const TIERS = {
  free: { quotaPerMonth: 50, logRetentionDays: 14 },
  pro: { quotaPerMonth: 5_000, logRetentionDays: 30 },
  business: { quotaPerMonth: 25_000, logRetentionDays: 180 },
  enterprise: { quotaPerMonth: Infinity, logRetentionDays: 365 },
  self_host: { quotaPerMonth: Infinity, logRetentionDays: Infinity },
} as const;

export type BillingTier = keyof typeof TIERS;
