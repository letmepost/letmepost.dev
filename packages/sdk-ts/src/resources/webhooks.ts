import type { HttpClient, RequestOptions } from "../http.js";
import type { WebhookEventType } from "../webhooks.js";

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEventType[];
  description?: string | null;
  active: boolean;
  lastDeliveryAt?: string | null;
  lastFailureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  /** HMAC-SHA256 signing secret. Returned once at creation. */
  signingSecret: string;
}

export interface WebhookEndpointListResponse {
  data: WebhookEndpoint[];
}

export interface CreateWebhookEndpointRequest {
  url: string;
  events?: WebhookEventType[];
  description?: string;
}

export interface UpdateWebhookEndpointRequest {
  url?: string;
  events?: WebhookEventType[];
  active?: boolean;
  description?: string | null;
}

export interface TestWebhookDeliveryRequest {
  type?: WebhookEventType;
  data?: unknown;
}

export interface TestWebhookDeliveryResponse {
  delivered: boolean;
  status: number | null;
  durationMs: number;
  responseBody?: string | null;
  deliveryId: string;
  nonRetryable?: boolean;
  errorName?: string | null;
  sentEvent: Record<string, unknown>;
}

export interface DeletedResponse {
  id: string;
  deleted: true;
}

export class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<WebhookEndpointListResponse> {
    return this.http.request<WebhookEndpointListResponse>(
      { method: "GET", path: "/v1/webhook-endpoints" },
      opts ?? {},
    );
  }

  get(id: string, opts?: RequestOptions): Promise<WebhookEndpoint> {
    return this.http.request<WebhookEndpoint>(
      { method: "GET", path: `/v1/webhook-endpoints/${encodeURIComponent(id)}` },
      opts ?? {},
    );
  }

  /** Dashboard-session only. */
  create(
    body: CreateWebhookEndpointRequest,
    opts?: RequestOptions,
  ): Promise<WebhookEndpointWithSecret> {
    return this.http.request<WebhookEndpointWithSecret>(
      { method: "POST", path: "/v1/webhook-endpoints", body },
      opts ?? {},
    );
  }

  /** Dashboard-session only. */
  update(
    id: string,
    body: UpdateWebhookEndpointRequest,
    opts?: RequestOptions,
  ): Promise<WebhookEndpoint> {
    return this.http.request<WebhookEndpoint>(
      {
        method: "PATCH",
        path: `/v1/webhook-endpoints/${encodeURIComponent(id)}`,
        body,
      },
      opts ?? {},
    );
  }

  /** Dashboard-session only. */
  delete(id: string, opts?: RequestOptions): Promise<DeletedResponse> {
    return this.http.request<DeletedResponse>(
      {
        method: "DELETE",
        path: `/v1/webhook-endpoints/${encodeURIComponent(id)}`,
      },
      opts ?? {},
    );
  }

  /** Dashboard-session only. Fires a synthetic event synchronously. */
  test(
    id: string,
    eventType?: WebhookEventType,
    opts?: RequestOptions,
  ): Promise<TestWebhookDeliveryResponse> {
    const body: TestWebhookDeliveryRequest =
      eventType !== undefined ? { type: eventType } : {};
    return this.http.request<TestWebhookDeliveryResponse>(
      {
        method: "POST",
        path: `/v1/webhook-endpoints/${encodeURIComponent(id)}/test`,
        body,
      },
      opts ?? {},
    );
  }
}
