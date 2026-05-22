import type { BillingTier } from "../tiers.js";

/**
 * Resolve a Lemon Squeezy variant id to one of our tiers. The mapping lives
 * in env so we can flip variants without a redeploy. Unknown variant ids
 * throw, so a misconfigured webhook payload surfaces as a 500 in the
 * handler and lands in `billing_events.processing_error`.
 */
export function tierForVariant(variantId: string): BillingTier {
  if (variantId === process.env.LMSQ_VARIANT_PRO) return "pro";
  if (variantId === process.env.LMSQ_VARIANT_BUSINESS) return "business";
  throw new Error(`Unknown Lemon Squeezy variant ${variantId}`);
}
