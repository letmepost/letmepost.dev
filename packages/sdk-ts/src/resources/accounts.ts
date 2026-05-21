import type { HttpClient, RequestOptions } from "../http.js";
import type { Platform } from "../errors.js";

export interface Account {
  id: string;
  profileId: string;
  platform: Platform;
  platformAccountId: string;
  displayName: string | null;
  tokenExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  pinterest?: {
    defaultBoardId?: string | null;
    defaultBoardName?: string | null;
  };
  instagram?: {
    kind?: string | null;
    accountType?: string | null;
    grantedScopes?: string[] | null;
  };
}

export interface AccountListResponse {
  data: Account[];
}

export interface ConnectDescriptorResponse {
  platform: Platform;
  state: "stable" | "trial" | "pending";
  descriptor: Record<string, unknown>;
}

export interface PinterestBoard {
  id: string;
  name: string;
  privacy?: "PUBLIC" | "PROTECTED" | "SECRET" | null;
}

export interface PinterestBoardsResponse {
  data: PinterestBoard[];
  defaultBoardId?: string | null;
}

export interface CreatePinterestBoardRequest {
  name: string;
  description?: string;
  privacy?: "PUBLIC" | "PROTECTED" | "SECRET";
  setAsDefault?: boolean;
  upsert?: boolean;
}

export type CreatePinterestBoardResponse = PinterestBoard & {
  existing?: boolean;
  defaultBoardId?: string;
  defaultBoardName?: string;
};

export interface SetPinterestDefaultBoardResponse {
  id: string;
  defaultBoardId: string | null;
  defaultBoardName: string | null;
}

export interface DeletedResponse {
  id: string;
  deleted: true;
}

export class AccountsResource {
  constructor(private readonly http: HttpClient) {}

  list(
    params: { profileId?: string } = {},
    opts?: RequestOptions,
  ): Promise<AccountListResponse> {
    return this.http.request<AccountListResponse>(
      { method: "GET", path: "/v1/accounts", query: params },
      opts ?? {},
    );
  }

  get(id: string, opts?: RequestOptions): Promise<Account> {
    return this.http.request<Account>(
      { method: "GET", path: `/v1/accounts/${encodeURIComponent(id)}` },
      opts ?? {},
    );
  }

  /**
   * Dashboard-session only. Programmatic API keys cannot disconnect accounts;
   * the API will respond with `unauthorized` if called with a Bearer key.
   */
  delete(id: string, opts?: RequestOptions): Promise<DeletedResponse> {
    return this.http.request<DeletedResponse>(
      { method: "DELETE", path: `/v1/accounts/${encodeURIComponent(id)}` },
      opts ?? {},
    );
  }

  /** Dashboard-session only. See `delete` for the caveat. */
  connect(
    platform: Platform,
    body: { profileId?: string } = {},
    opts?: RequestOptions,
  ): Promise<ConnectDescriptorResponse> {
    return this.http.request<ConnectDescriptorResponse>(
      {
        method: "POST",
        path: `/v1/accounts/connect/${encodeURIComponent(platform)}`,
        body,
      },
      opts ?? {},
    );
  }

  /** Dashboard-session only. See `delete` for the caveat. */
  completeConnect(
    platform: Platform,
    body: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<Account> {
    return this.http.request<Account>(
      {
        method: "POST",
        path: `/v1/accounts/connect/${encodeURIComponent(platform)}/complete`,
        body,
      },
      opts ?? {},
    );
  }

  listPinterestBoards(
    accountId: string,
    opts?: RequestOptions,
  ): Promise<PinterestBoardsResponse> {
    return this.http.request<PinterestBoardsResponse>(
      {
        method: "GET",
        path: `/v1/accounts/${encodeURIComponent(accountId)}/pinterest/boards`,
      },
      opts ?? {},
    );
  }

  addPinterestBoard(
    accountId: string,
    body: CreatePinterestBoardRequest,
    opts?: RequestOptions,
  ): Promise<CreatePinterestBoardResponse> {
    return this.http.request<CreatePinterestBoardResponse>(
      {
        method: "POST",
        path: `/v1/accounts/${encodeURIComponent(accountId)}/pinterest/boards`,
        body,
      },
      opts ?? {},
    );
  }

  setPinterestDefaultBoard(
    accountId: string,
    body: { boardId: string },
    opts?: RequestOptions,
  ): Promise<SetPinterestDefaultBoardResponse> {
    return this.http.request<SetPinterestDefaultBoardResponse>(
      {
        method: "PATCH",
        path: `/v1/accounts/${encodeURIComponent(accountId)}/pinterest/default-board`,
        body,
      },
      opts ?? {},
    );
  }
}
