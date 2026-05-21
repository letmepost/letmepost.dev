import type { HttpClient, RequestOptions } from "../http.js";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: string[];
  profileId?: string | null;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface ApiKeyListResponse {
  data: ApiKey[];
}

export interface CreateApiKeyRequest {
  name: string;
  prefix?: "lmp_live_" | "lmp_test_";
  scopes?: string[];
  profileId?: string | null;
}

export interface CreateApiKeyResponse extends ApiKey {
  /** Plaintext key. Shown once, never again. */
  key: string;
}

export interface RevokeApiKeyResponse {
  id: string;
  revokedAt: string;
}

export class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

  list(opts?: RequestOptions): Promise<ApiKeyListResponse> {
    return this.http.request<ApiKeyListResponse>(
      { method: "GET", path: "/v1/api-keys" },
      opts ?? {},
    );
  }

  /** Dashboard-session only. Programmatic keys cannot mint new keys. */
  create(
    body: CreateApiKeyRequest,
    opts?: RequestOptions,
  ): Promise<CreateApiKeyResponse> {
    return this.http.request<CreateApiKeyResponse>(
      { method: "POST", path: "/v1/api-keys", body },
      opts ?? {},
    );
  }

  /** Dashboard-session only. */
  delete(id: string, opts?: RequestOptions): Promise<RevokeApiKeyResponse> {
    return this.http.request<RevokeApiKeyResponse>(
      { method: "DELETE", path: `/v1/api-keys/${encodeURIComponent(id)}` },
      opts ?? {},
    );
  }
}
