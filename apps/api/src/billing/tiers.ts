// Quota is monthly post count, retention is days posts stay in the log
// before cleanup. Infinity means uncapped (quota gate short-circuits and
// retention cleanup is skipped). Enterprise is intentionally absent until
// a sales path exists to flip an org onto it.
export const TIERS = {
  free: { quotaPerMonth: 50, logRetentionDays: 14 },
  pro: { quotaPerMonth: 5_000, logRetentionDays: 30 },
  business: { quotaPerMonth: 25_000, logRetentionDays: 180 },
  self_host: { quotaPerMonth: Infinity, logRetentionDays: Infinity },
} as const;

export type BillingTier = keyof typeof TIERS;
