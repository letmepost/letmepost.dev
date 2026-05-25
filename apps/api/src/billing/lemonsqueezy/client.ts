// Thin Lemon Squeezy REST API wrapper. Base URL + token come from env so
// tests can swap in MSW. Errors are surfaced as LetmepostError so the
// existing onError handler envelopes them.
import { LetmepostError } from "../../errors.js";

const DEFAULT_BASE = "https://api.lemonsqueezy.com/v1";

function baseUrl(): string {
  return process.env.LMSQ_API_BASE ?? DEFAULT_BASE;
}

function apiKey(): string {
  const key = process.env.LMSQ_API_KEY;
  if (!key) {
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message: "LMSQ_API_KEY is not configured.",
    });
  }
  return key;
}

async function lsFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LetmepostError({
      code: "platform_unavailable",
      status: 502,
      message: `Lemon Squeezy API call failed (${res.status}).`,
      platform: "lemonsqueezy",
      platformResponse: text,
    });
  }
  return (await res.json()) as T;
}

type CustomerResponse = {
  data?: {
    attributes?: { urls?: { customer_portal?: string } };
  };
};

export async function mintCustomerPortalUrl(
  customerId: string,
): Promise<string | null> {
  const json = await lsFetch<CustomerResponse>(`/customers/${customerId}`, {
    method: "GET",
  });
  return json.data?.attributes?.urls?.customer_portal ?? null;
}

export async function cancelSubscription(
  subscriptionId: string,
): Promise<void> {
  await lsFetch(`/subscriptions/${subscriptionId}`, { method: "DELETE" });
}

export async function resumeSubscription(
  subscriptionId: string,
): Promise<void> {
  await lsFetch(`/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "subscriptions",
        id: subscriptionId,
        attributes: { cancelled: false },
      },
    }),
  });
}

export type InvoiceListEntry = {
  id: string;
  number: string | null;
  status: string | null;
  total: number | null;
  currency: string | null;
  createdAt: string | null;
  invoiceUrl: string | null;
};

type InvoicesResponse = {
  data?: Array<{
    id: string;
    attributes?: {
      invoice_number?: string;
      status?: string;
      total?: number;
      currency?: string;
      created_at?: string;
      urls?: { invoice_url?: string };
    };
  }>;
  meta?: { page?: { total?: number; currentPage?: number } };
};

// Lemon Squeezy /v1/subscription-invoices supports filter[subscription_id]
// reliably. filter[customer_id] is undocumented and was returning empty in
// practice. We pass subscription_id so the row's lsSubscriptionId pins the
// query to this org's invoices unambiguously.
export async function listInvoicesForSubscription(
  subscriptionId: string,
  page: number,
  perPage: number,
): Promise<{ data: InvoiceListEntry[]; nextPage: number | null }> {
  const search = new URLSearchParams({
    "filter[subscription_id]": subscriptionId,
    "page[number]": String(page),
    "page[size]": String(perPage),
    sort: "-created_at",
  });
  const json = await lsFetch<InvoicesResponse>(
    `/subscription-invoices?${search.toString()}`,
    { method: "GET" },
  );
  const data: InvoiceListEntry[] = (json.data ?? []).map((row) => ({
    id: row.id,
    number: row.attributes?.invoice_number ?? null,
    status: row.attributes?.status ?? null,
    total: row.attributes?.total ?? null,
    currency: row.attributes?.currency ?? null,
    createdAt: row.attributes?.created_at ?? null,
    invoiceUrl: row.attributes?.urls?.invoice_url ?? null,
  }));
  const hasMore = data.length === perPage;
  return { data, nextPage: hasMore ? page + 1 : null };
}

type CheckoutResponse = {
  data?: { attributes?: { url?: string } };
};

/**
 * Create a Lemon Squeezy checkout session and return its URL. We call the
 * Checkouts API (rather than constructing a /buy/<variant> link client-side)
 * because the API auto-handles test vs live mode based on the API key, uses
 * the correct store slug subdomain, and signs the custom_data payload so it
 * round-trips back on the webhook as `meta.custom_data.organization_id`.
 */
export async function createCheckoutUrl(
  variantId: string,
  customData: Record<string, string>,
): Promise<string> {
  const storeId = process.env.LMSQ_STORE_ID;
  if (!storeId) {
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message: "LMSQ_STORE_ID is not configured.",
    });
  }
  const json = await lsFetch<CheckoutResponse>("/checkouts", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            custom: customData,
          },
        },
        relationships: {
          store: { data: { type: "stores", id: storeId } },
          variant: { data: { type: "variants", id: variantId } },
        },
      },
    }),
  });
  const url = json.data?.attributes?.url;
  if (typeof url !== "string") {
    throw new LetmepostError({
      code: "platform_unavailable",
      status: 502,
      message: "Lemon Squeezy did not return a checkout URL.",
      platform: "lemonsqueezy",
    });
  }
  return url;
}
