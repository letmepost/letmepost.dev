import { API_URL } from "./env";

/**
 * Thin fetch wrapper for the letmepost HTTP API. Every call includes
 * `credentials: "include"` so better-auth's session cookie travels
 * cross-origin (dashboard on :3001, API on :3000), and unpacks the error
 * contract into a typed throwable so callers can show a real message instead
 * of "Something went wrong."
 */

export type ApiError = {
  code: string;
  message: string;
  rule?: string;
  platform?: string;
  platformResponse?: unknown;
  remediation?: string;
  requestId?: string;
  traceId?: string;
  status: number;
};

export class ApiRequestError extends Error {
  readonly payload: ApiError;
  constructor(payload: ApiError) {
    super(payload.message);
    this.payload = payload;
    this.name = "ApiRequestError";
  }
}

type RequestOpts = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Pass a `FormData` instance to send multipart; anything else is JSON-stringified. */
  body?: unknown;
  headers?: Record<string, string>;
  /** When true, do not throw on non-2xx — return the parsed error instead. */
  returnErrorAsResult?: boolean;
};

export async function apiFetch<T>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_URL}${path}`;
  // FormData bodies are sent verbatim — the browser owns the multipart
  // boundary and sets the Content-Type itself. Setting our usual JSON
  // Content-Type breaks the boundary negotiation, so it has to be omitted
  // for the upload path.
  const isFormData =
    typeof FormData !== "undefined" && opts.body instanceof FormData;
  const baseHeaders: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };
  if (!isFormData) {
    baseHeaders["Content-Type"] =
      baseHeaders["Content-Type"] ?? "application/json";
  }
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    credentials: "include",
    headers: baseHeaders,
    body:
      opts.body === undefined
        ? undefined
        : isFormData
          ? (opts.body as FormData)
          : JSON.stringify(opts.body),
  });

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const body = (parsed ?? {}) as Record<string, unknown>;
    const envelope = (body.error ?? {}) as Record<string, unknown>;
    const err: ApiError = {
      code: (envelope.code as string | undefined) ?? "unknown_error",
      message:
        (envelope.message as string | undefined) ??
        `Request failed with status ${res.status}`,
      rule: envelope.rule as string | undefined,
      platform: envelope.platform as string | undefined,
      platformResponse: envelope.platformResponse,
      remediation: envelope.remediation as string | undefined,
      requestId: envelope.requestId as string | undefined,
      traceId: envelope.traceId as string | undefined,
      status: res.status,
    };
    throw new ApiRequestError(err);
  }

  return parsed as T;
}
