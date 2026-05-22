import { z } from "zod";

export const ErrorCode = z.enum([
  "validation_failed",
  "preflight_failed",
  "platform_auth_failed",
  "platform_rejected",
  "platform_unavailable",
  "platform_not_enabled",
  "internal_error",
  "unauthenticated",
  "unauthorized",
  "not_found",
  "idempotency_conflict",
  "rate_limited",
  "quota_exceeded",
  "payment_required",
  "feature_not_in_plan",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    rule: z.string().optional().describe("The specific preflight rule or validator that failed"),
    platform: z.string().optional(),
    platformVersion: z.string().optional().describe("Pinned upstream API version the call targeted"),
    platformResponse: z.unknown().optional().describe("Raw upstream platform response, when available"),
    remediation: z.string().optional().describe("Actionable next step for the caller"),
    docUrl: z.string().optional().describe("Link to the docs page for this error code"),
    ruleUrl: z.string().optional().describe("Link to the docs page for this preflight rule (set when `rule` is present)"),
    requestId: z.string().optional().describe("Per-request correlation id, echoed in the x-request-id response header"),
    traceId: z.string().optional().describe("OTel trace id, when tracing is active"),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/**
 * Convert a preflight rule id like `bluesky.text.max_graphemes` into the
 * docs URL slug `bluesky-text-max_graphemes`. Dots map to hyphens; segment-
 * internal underscores are preserved so the slug matches the on-disk
 * filename in `docs/preflight/<slug>.mdx`.
 */
export function slugifyRule(rule: string): string {
  return rule.replace(/\./g, "-").toLowerCase();
}
