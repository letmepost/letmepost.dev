import { LetmepostError } from "../../errors.js";

/** Build a `platform_auth_failed` error (401) for a failed session/OAuth step. */
export function authFailed(params: {
  platform: string;
  platformResponse?: unknown;
  message?: string;
  remediation?: string;
}): LetmepostError {
  return new LetmepostError({
    code: "platform_auth_failed",
    status: 401,
    message: params.message ?? `${params.platform} authentication failed.`,
    platform: params.platform,
    remediation: params.remediation ?? "Verify the account credentials.",
    ...(params.platformResponse !== undefined
      ? { platformResponse: params.platformResponse }
      : {}),
  });
}

/**
 * Build a `platform_rejected` error (502) for a non-auth upstream failure —
 * e.g. platform validates the post asynchronously and refuses it.
 *
 * `rule` is optional but encouraged when the rejection maps cleanly to a
 * known cause (e.g. IG's `2207052` → `instagram.media.reachable`); rule
 * ids let the dashboard's Post Log filter and the docs site cross-link.
 */
export function rejected(params: {
  platform: string;
  platformResponse?: unknown;
  upstreamMessage?: string;
  remediation?: string;
  rule?: string;
}): LetmepostError {
  const base = `${params.platform} rejected the post`;
  const message = params.upstreamMessage ? `${base}: ${params.upstreamMessage}` : `${base}.`;
  return new LetmepostError({
    code: "platform_rejected",
    status: 502,
    message,
    platform: params.platform,
    remediation:
      params.remediation ?? "Inspect platformResponse for the upstream error detail.",
    ...(params.rule !== undefined ? { rule: params.rule } : {}),
    ...(params.platformResponse !== undefined
      ? { platformResponse: params.platformResponse }
      : {}),
  });
}

/**
 * The upstream detail to attach as `platformResponse`.
 *
 * Callers used to write `res.body ?? res.raw ?? undefined`, which silently
 * produced *nothing* when the platform answered with an empty body — and an
 * empty body is exactly when you most need to know what happened. The result
 * was an error record reading `"platform_rejected" / "twitter rejected the
 * post."` whose own remediation said "Inspect platformResponse for the
 * upstream error detail", with no platformResponse to inspect and the HTTP
 * status discarded. Undiagnosable after the fact.
 *
 * When there is a body or a raw payload the contract is unchanged — that
 * value is passed through as before. The status-only object is the fallback
 * for the empty case, so a bare 403 or 503 still says something.
 */
export function upstreamDetail(res: {
  status: number;
  body: unknown;
  raw: string | null;
}): unknown {
  return res.body ?? res.raw ?? { httpStatus: res.status };
}

/** Pull a human-readable `message` out of a loosely-typed upstream JSON body. */
export function extractUpstreamMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return undefined;
}
