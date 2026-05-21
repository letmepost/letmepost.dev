import type { HttpClient, RequestOptions } from "../http.js";

export interface MediaAsset {
  id: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  profileId?: string;
}

export interface MediaListResponse {
  data: MediaAsset[];
  nextCursor?: string | null;
}

export interface ListMediaParams {
  profileId?: string;
  limit?: number;
  cursor?: string;
}

export class MediaResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List previously uploaded media. The upload endpoint itself is multipart
   * and intentionally left out of the SDK surface in v0.1. Use `POST /v1/media`
   * directly with `fetch` + `FormData` when you need it. We'll add a typed
   * `upload()` once the streaming-upload story stabilizes.
   */
  list(params: ListMediaParams = {}, opts?: RequestOptions): Promise<MediaListResponse> {
    return this.http.request<MediaListResponse>(
      { method: "GET", path: "/v1/media", query: params as Record<string, unknown> },
      opts ?? {},
    );
  }
}
