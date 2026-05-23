/**
 * Typed errors for the letmepost.dev SDK.
 *
 * The HTTP layer maps the wire envelope (`{ error: { code, message, ... } }`)
 * onto one subclass per `ErrorCode`. Catch the base `LetmepostError` for
 * coarse handling, or branch on the specific subclass for surgical retries
 * (e.g. only retry `PlatformUnavailableError` and `RateLimitedError`).
 */

export type ErrorCode =
  | "validation_failed"
  | "preflight_failed"
  | "platform_auth_failed"
  | "platform_rejected"
  | "platform_unavailable"
  | "platform_not_enabled"
  | "internal_error"
  | "unauthenticated"
  | "unauthorized"
  | "not_found"
  | "idempotency_conflict"
  | "rate_limited";

export type Platform =
  | "bluesky"
  | "facebook"
  | "instagram"
  | "linkedin"
  | "pinterest"
  | "threads"
  | "tiktok"
  | "twitter";

export interface ErrorEnvelope {
  code: ErrorCode | string;
  message: string;
  rule?: string;
  platform?: Platform | string;
  platformVersion?: string;
  platformResponse?: unknown;
  remediation?: string;
  docUrl?: string;
  ruleUrl?: string;
  requestId?: string;
  traceId?: string;
}

export interface LetmepostErrorInit extends ErrorEnvelope {
  status: number;
}

export class LetmepostError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly rule?: string;
  readonly platform?: Platform | string;
  readonly platformVersion?: string;
  readonly platformResponse?: unknown;
  readonly remediation?: string;
  readonly docUrl?: string;
  readonly ruleUrl?: string;
  readonly requestId?: string;
  readonly traceId?: string;

  constructor(init: LetmepostErrorInit) {
    super(init.message);
    this.name = "LetmepostError";
    this.code = init.code;
    this.status = init.status;
    if (init.rule !== undefined) this.rule = init.rule;
    if (init.platform !== undefined) this.platform = init.platform;
    if (init.platformVersion !== undefined) this.platformVersion = init.platformVersion;
    if (init.platformResponse !== undefined) this.platformResponse = init.platformResponse;
    if (init.remediation !== undefined) this.remediation = init.remediation;
    if (init.docUrl !== undefined) this.docUrl = init.docUrl;
    if (init.ruleUrl !== undefined) this.ruleUrl = init.ruleUrl;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.traceId !== undefined) this.traceId = init.traceId;
  }
}

export class ValidationError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "ValidationError";
  }
}

export class PreflightFailedError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "PreflightFailedError";
  }
}

export class PlatformAuthError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "PlatformAuthError";
  }
}

export class PlatformRejectedError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "PlatformRejectedError";
  }
}

export class PlatformUnavailableError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "PlatformUnavailableError";
  }
}

export class PlatformNotEnabledError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "PlatformNotEnabledError";
  }
}

export class InternalError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "InternalError";
  }
}

export class UnauthenticatedError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "UnauthenticatedError";
  }
}

export class UnauthorizedError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "NotFoundError";
  }
}

export class IdempotencyConflictError extends LetmepostError {
  constructor(init: LetmepostErrorInit) {
    super(init);
    this.name = "IdempotencyConflictError";
  }
}

export class RateLimitedError extends LetmepostError {
  /** Seconds to wait before retrying, parsed from the `Retry-After` header. */
  readonly retryAfterSeconds?: number;
  constructor(init: LetmepostErrorInit & { retryAfterSeconds?: number }) {
    super(init);
    this.name = "RateLimitedError";
    if (init.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = init.retryAfterSeconds;
    }
  }
}

/** Mapping from wire `code` to the concrete error subclass. */
const REGISTRY: Record<string, new (init: LetmepostErrorInit) => LetmepostError> = {
  validation_failed: ValidationError,
  preflight_failed: PreflightFailedError,
  platform_auth_failed: PlatformAuthError,
  platform_rejected: PlatformRejectedError,
  platform_unavailable: PlatformUnavailableError,
  platform_not_enabled: PlatformNotEnabledError,
  internal_error: InternalError,
  unauthenticated: UnauthenticatedError,
  unauthorized: UnauthorizedError,
  not_found: NotFoundError,
  idempotency_conflict: IdempotencyConflictError,
  rate_limited: RateLimitedError,
};

/**
 * Map a parsed error response onto the right subclass. Unknown codes fall back
 * to the base class so forward-compatible servers (new codes) still raise
 * something the caller can catch.
 */
export function errorFromResponse(args: {
  status: number;
  body: unknown;
  requestIdHeader?: string;
  retryAfterSeconds?: number;
}): LetmepostError {
  const envelope = parseEnvelope(args.body, args.requestIdHeader);
  if (!envelope) {
    return new LetmepostError({
      status: args.status,
      code: codeForStatus(args.status),
      message: bodyToMessage(args.body, args.status),
      ...(args.requestIdHeader !== undefined ? { requestId: args.requestIdHeader } : {}),
    });
  }
  const Ctor = REGISTRY[envelope.code] ?? LetmepostError;
  if (Ctor === RateLimitedError) {
    return new RateLimitedError({
      ...envelope,
      status: args.status,
      ...(args.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: args.retryAfterSeconds }
        : {}),
    });
  }
  return new Ctor({ ...envelope, status: args.status });
}

function parseEnvelope(
  body: unknown,
  requestIdFallback: string | undefined,
): ErrorEnvelope | null {
  if (!body || typeof body !== "object") return null;
  const maybe = body as { error?: unknown };
  if (!maybe.error || typeof maybe.error !== "object") return null;
  const err = maybe.error as Record<string, unknown>;
  if (typeof err["code"] !== "string" || typeof err["message"] !== "string") {
    return null;
  }
  const out: ErrorEnvelope = {
    code: err["code"],
    message: err["message"],
  };
  if (typeof err["rule"] === "string") out.rule = err["rule"];
  if (typeof err["platform"] === "string") out.platform = err["platform"];
  if (typeof err["platformVersion"] === "string") out.platformVersion = err["platformVersion"];
  if (err["platformResponse"] !== undefined) out.platformResponse = err["platformResponse"];
  if (typeof err["remediation"] === "string") out.remediation = err["remediation"];
  if (typeof err["docUrl"] === "string") out.docUrl = err["docUrl"];
  if (typeof err["ruleUrl"] === "string") out.ruleUrl = err["ruleUrl"];
  if (typeof err["requestId"] === "string") {
    out.requestId = err["requestId"];
  } else if (requestIdFallback) {
    out.requestId = requestIdFallback;
  }
  if (typeof err["traceId"] === "string") out.traceId = err["traceId"];
  return out;
}

function codeForStatus(status: number): ErrorCode | string {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "idempotency_conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal_error";
  return "validation_failed";
}

function bodyToMessage(body: unknown, status: number): string {
  if (typeof body === "string" && body.length > 0) return body.slice(0, 500);
  if (body && typeof body === "object") {
    try {
      return JSON.stringify(body).slice(0, 500);
    } catch {
      // fall through
    }
  }
  return `HTTP ${status}`;
}
