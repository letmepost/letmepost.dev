/**
 * HTTP layer for the SDK. Handles:
 *   - Bearer auth
 *   - JSON encoding / decoding
 *   - Automatic Idempotency-Key on every non-GET (override per call)
 *   - Exponential backoff on 5xx + 429, honoring Retry-After when present
 *   - Mapping non-2xx responses onto typed error subclasses
 */

import { newIdempotencyKey } from "./idempotency.js";
import { errorFromResponse, LetmepostError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Max retry attempts on 5xx / 429. Defaults to 3. */
  retries?: number;
  /** Base ms for the exponential backoff. Defaults to 500. */
  retryBaseMs?: number;
  /** Caps how long we'll honor a `Retry-After` header. Defaults to 30s. */
  retryAfterMaxMs?: number;
  /** Extra headers attached to every request (e.g. tracing). */
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  /** Override the automatic UUID Idempotency-Key. */
  idempotencyKey?: string;
  /** Disable retries for a single call (default: honors client config). */
  retries?: number;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
}

const DEFAULT_BASE_URL = "https://api.letmepost.dev";
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_AFTER_MAX_MS = 30_000;

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly retryAfterMaxMs: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: ClientConfig) {
    if (!config.apiKey || typeof config.apiKey !== "string") {
      throw new Error("letmepost: `apiKey` is required.");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f =
      config.fetch ??
      (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) {
      throw new Error(
        "letmepost: no `fetch` implementation found. Pass `fetch` in the client config, or upgrade to Node >=18.",
      );
    }
    this.fetchImpl = f.bind(globalThis);
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryAfterMaxMs = config.retryAfterMaxMs ?? DEFAULT_RETRY_AFTER_MAX_MS;
    this.defaultHeaders = config.defaultHeaders ?? {};
  }

  async request<T>(req: HttpRequest, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(req.path, req.query);
    const isWrite = req.method !== "GET";
    const idempotencyKey =
      opts.idempotencyKey ?? (isWrite ? newIdempotencyKey() : undefined);
    const maxRetries = opts.retries ?? this.retries;

    let lastError: LetmepostError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const headers = this.buildHeaders({
        idempotencyKey,
        extra: opts.headers,
        hasBody: req.body !== undefined,
      });

      const init: RequestInit = {
        method: req.method,
        headers,
      };
      if (req.body !== undefined) {
        init.body = JSON.stringify(req.body);
      }
      if (opts.signal) {
        init.signal = opts.signal;
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, init);
      } catch (err) {
        // Network / DNS / TLS failure. Retry within budget; otherwise surface.
        if (attempt < maxRetries) {
          await sleep(this.backoffMs(attempt));
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new LetmepostError({
          status: 0,
          code: "internal_error",
          message: `letmepost: network request failed: ${message}`,
        });
      }

      const requestId = res.headers.get("x-request-id") ?? undefined;
      const text = await res.text();
      const parsedBody = parseJson(text);

      if (res.ok) {
        if (res.status === 204 || text.length === 0) {
          return undefined as unknown as T;
        }
        return parsedBody as T;
      }

      const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
      lastError = errorFromResponse({
        status: res.status,
        body: parsedBody,
        ...(requestId !== undefined ? { requestIdHeader: requestId } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retryable || attempt >= maxRetries) {
        throw lastError;
      }

      const waitMs = this.waitMsForRetry(retryAfterSeconds, attempt);
      await sleep(waitMs);
    }

    // Loop exit without return / throw is unreachable but TypeScript can't prove it.
    throw lastError ?? new LetmepostError({
      status: 0,
      code: "internal_error",
      message: "letmepost: exhausted retries without a response",
    });
  }

  private buildUrl(path: string, query: Record<string, unknown> | undefined): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const qs = encodeQuery(query);
    return qs ? `${this.baseUrl}${suffix}?${qs}` : `${this.baseUrl}${suffix}`;
  }

  private buildHeaders(args: {
    idempotencyKey: string | undefined;
    extra: Record<string, string> | undefined;
    hasBody: boolean;
  }): Headers {
    const h = new Headers();
    h.set("Authorization", `Bearer ${this.apiKey}`);
    h.set("Accept", "application/json");
    h.set("User-Agent", "letmepost-sdk-ts/0.1.0");
    if (args.hasBody) h.set("Content-Type", "application/json");
    if (args.idempotencyKey) h.set("Idempotency-Key", args.idempotencyKey);
    for (const [k, v] of Object.entries(this.defaultHeaders)) h.set(k, v);
    for (const [k, v] of Object.entries(args.extra ?? {})) h.set(k, v);
    return h;
  }

  private backoffMs(attempt: number): number {
    // 500ms, 1000ms, 2000ms, ... capped at 8s. Jitter cuts thundering herds.
    const raw = Math.min(this.retryBaseMs * 2 ** attempt, 8_000);
    return raw / 2 + Math.random() * (raw / 2);
  }

  private waitMsForRetry(retryAfterSeconds: number | undefined, attempt: number): number {
    if (retryAfterSeconds !== undefined) {
      return Math.min(retryAfterSeconds * 1000, this.retryAfterMaxMs);
    }
    return this.backoffMs(attempt);
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  // HTTP-date form. Convert to seconds-until-deadline.
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const seconds = Math.max(0, Math.round((date - Date.now()) / 1000));
    return seconds;
  }
  return undefined;
}

function encodeQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
