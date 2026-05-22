/**
 * Client-side shape mirror of the `/v1/billing/*` contract.
 *
 * Kept loose-typed (no zod) since this lives in a different bundle from the
 * API server. If a field comes back missing the UI renders gracefully — the
 * underlying subscription record might predate the field.
 *
 * TanStack Query hooks follow the same pattern as the rest of the dashboard:
 * `useFooQuery` / `useFooMutation`, all keys live under `queryKeys.billing`
 * in `query-keys.ts`, mutations call `queryClient.invalidateQueries` on
 * success so the surrounding UI catches up.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiFetch } from "./api";
import { queryKeys } from "./query-keys";

export type BillingTier =
  | "free"
  | "pro"
  | "business"
  | "enterprise"
  | "self_host";

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
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  grandfathered: boolean;
  grandfatheredUntil: string | null;
  delinquent: boolean;
};

export type Usage = {
  period: string;
  postsCount: number;
  quota: number;
  percent: number;
  resetAt: string;
};

export type Invoice = {
  id: string;
  number: string;
  amount: number;
  currency: string;
  status: "paid" | "refunded" | "void" | "pending";
  issuedAt: string;
  pdfUrl: string | null;
};

export type InvoicePage = {
  data: Invoice[];
  nextCursor: string | null;
};

/**
 * Canonical tier facts. Mirrors the pricing copy on the marketing site
 * (`apps/web/src/pages/pricing.astro`) but expressed as a typed constant so
 * the dashboard can render plan cards, quota maths, and upgrade flows from a
 * single source of truth. Update both when pricing shifts.
 */
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
  enterprise: {
    name: "Enterprise",
    price: null,
    quotaPerMonth: null,
    logRetentionDays: 365,
    tagline: "SSO, custom SLA, DPA.",
    features: [],
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

/**
 * Tier ordering for upgrade/downgrade comparisons. Higher index = higher
 * tier. Enterprise + self_host live off the ladder; comparison helpers
 * below treat them specially.
 */
const TIER_RANK: Record<BillingTier, number> = {
  free: 0,
  pro: 1,
  business: 2,
  enterprise: 3,
  self_host: -1,
};

export function compareTiers(a: BillingTier, b: BillingTier): number {
  return TIER_RANK[a] - TIER_RANK[b];
}

/** True when quota should render as "Unlimited" instead of a number. */
export function isUnlimitedQuota(quota: number | null | undefined): boolean {
  if (quota === null || quota === undefined) return true;
  return quota >= 1_000_000;
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
      const cursor = pageParam as string | null;
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return apiFetch<InvoicePage>(`/v1/billing/invoices${qs}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
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
    },
  });
}

// ───────────────────────── formatters ─────────────────────────

/** Format cents → "$12.34" for invoice rows. Falls back to raw on bad input. */
export function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** ISO timestamp → "May 22, 2026". Returns "—" for null/invalid. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
