// Client-side shape mirror of /v1/billing/*. Field names match the API
// response 1:1 so the dashboard never re-keys. Hooks live alongside the
// types because they share types.

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiFetch } from "./api";
import { queryKeys } from "./query-keys";

export type BillingTier = "free" | "pro" | "business" | "self_host";

export type BillingStatus =
  | "free"
  | "active"
  | "past_due"
  | "delinquent"
  | "cancelled"
  | "expired"
  | "paused";

export type Subscription = {
  tier: BillingTier;
  status: BillingStatus;
  quotaPerMonth: number | null;
  logRetentionDays: number | null;
  grandfathered: boolean;
  grandfatheredUntil: string | null;
  delinquent: boolean;
  source: "billing_disabled" | "grandfather" | "subscription" | "default_free";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
};

export type Usage = {
  period: string;
  postsCount: number;
  quota: number | null;
  percent: number;
  resetAt: string;
};

export type Invoice = {
  id: string;
  number: string | null;
  total: number | null;
  currency: string | null;
  status: string | null;
  createdAt: string | null;
  invoiceUrl: string | null;
};

export type InvoicePage = {
  data: Invoice[];
  nextPage: number | null;
};

// Per-tier copy + numbers. Mirrors apps/web/src/pages/pricing.astro and the
// API's TIERS constant; update all three when pricing shifts.
export const TIERS = {
  free: {
    name: "Free",
    price: 0,
    quotaPerMonth: 50,
    logRetentionDays: 14,
    tagline: "Indefinite, not a trial.",
    features: [
      "50 posts / month",
      "All 7 platforms, all API surface",
      "MCP server + CLI",
      "Community Discord support",
    ],
  },
  pro: {
    name: "Pro",
    price: 79,
    quotaPerMonth: 5_000,
    logRetentionDays: 30,
    tagline: "For a SaaS or a side project.",
    features: [
      "5,000 posts / month",
      "All 7 platforms, all API surface",
      "MCP server + CLI",
      "All webhook events",
      "30-day publish logs",
      "Email support, 24h response",
    ],
  },
  business: {
    name: "Business",
    price: 299,
    quotaPerMonth: 25_000,
    logRetentionDays: 180,
    tagline: "For real SaaS + agency workflows.",
    features: [
      "25,000 posts / month",
      "All 7 platforms, all API surface",
      "MCP server + CLI",
      "White-label OAuth (your brand)",
      "99.9% uptime SLA",
      "180-day publish logs",
      "Priority Slack + email, 4h response",
    ],
  },
  self_host: {
    name: "Self-host",
    price: 0,
    quotaPerMonth: null,
    logRetentionDays: null,
    tagline: "Run your own under Apache 2.0.",
    features: [],
  },
} as const satisfies Record<
  BillingTier,
  {
    name: string;
    price: number | null;
    quotaPerMonth: number | null;
    logRetentionDays: number | null;
    tagline: string;
    features: readonly string[];
  }
>;

// Upgrade/downgrade ordering. Higher rank means higher tier. self_host
// is off the commercial ladder.
const TIER_RANK: Record<BillingTier, number> = {
  free: 0,
  pro: 1,
  business: 2,
  self_host: -1,
};

export function compareTiers(a: BillingTier, b: BillingTier): number {
  return TIER_RANK[a] - TIER_RANK[b];
}

// True when quota should render as "Unlimited" instead of a number. The
// API returns null for Infinity tiers (self_host, grandfather) so this is
// a simple null check, not a magic number.
export function isUnlimitedQuota(quota: number | null | undefined): boolean {
  return quota === null || quota === undefined;
}

// ───────────────────────── queries ─────────────────────────

export function useSubscription() {
  return useQuery<Subscription>({
    queryKey: queryKeys.billing.subscription(),
    queryFn: () => apiFetch<Subscription>("/v1/billing/subscription"),
    refetchOnWindowFocus: true,
  });
}

export function useUsage() {
  return useQuery<Usage>({
    queryKey: queryKeys.billing.usage(),
    queryFn: () => apiFetch<Usage>("/v1/billing/usage"),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useInvoices() {
  return useInfiniteQuery<InvoicePage>({
    queryKey: queryKeys.billing.invoices(),
    queryFn: ({ pageParam }) => {
      const page = (pageParam as number | null) ?? 1;
      return apiFetch<InvoicePage>(`/v1/billing/invoices?page=${page}`);
    },
    initialPageParam: 1 as number | null,
    getNextPageParam: (last) => last.nextPage,
  });
}

// ───────────────────────── mutations ─────────────────────────

export function useCheckout() {
  return useMutation<{ url: string }, Error, { targetTier: "pro" | "business" }>(
    {
      mutationFn: (vars) =>
        apiFetch<{ url: string }>("/v1/billing/checkout", {
          method: "POST",
          body: vars,
        }),
    },
  );
}

export function usePortal() {
  return useMutation<{ url: string }, Error, void>({
    mutationFn: () =>
      apiFetch<{ url: string }>("/v1/billing/portal", { method: "POST" }),
  });
}

export function useSyncBilling() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () =>
      apiFetch<{ ok: true }>("/v1/billing/sync", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
      qc.invalidateQueries({ queryKey: queryKeys.billing.usage() });
      qc.invalidateQueries({ queryKey: queryKeys.billing.invoices() });
    },
  });
}

export function useCancelSubscription() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () =>
      apiFetch<{ ok: true }>("/v1/billing/cancel", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
      qc.invalidateQueries({ queryKey: queryKeys.billing.usage() });
      qc.invalidateQueries({ queryKey: queryKeys.billing.invoices() });
    },
  });
}

export function useReactivateSubscription() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () =>
      apiFetch<{ ok: true }>("/v1/billing/reactivate", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
      qc.invalidateQueries({ queryKey: queryKeys.billing.usage() });
      qc.invalidateQueries({ queryKey: queryKeys.billing.invoices() });
    },
  });
}

// ───────────────────────── formatters ─────────────────────────

// Format cents into "$12.34". Falls back to raw on bad input.
export function formatMoney(
  amountCents: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amountCents === null || amountCents === undefined) return "-";
  const cur = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${cur}`;
  }
}

// ISO timestamp into "May 22, 2026". Returns "-" for null or invalid input.
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
