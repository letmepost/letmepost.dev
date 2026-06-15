import type { HttpClient, RequestOptions } from "../http.js";
import type { Platform, ErrorCode } from "../errors.js";

export type PostStatus =
  | "queued"
  | "validated"
  | "publishing"
  | "published"
  | "failed"
  | "rejected";

export type BatchStatus = "queued" | "published" | "partial_failed" | "failed";

export interface MediaInput {
  kind: "image" | "video";
  altText?: string;
  mediaId?: string;
  url?: string;
  bytesBase64?: string;
}

export interface FirstComment {
  text: string;
}

export type TargetOptions =
  | { platform: "twitter"; replyToTweetId?: string; quoteTweetId?: string }
  | {
      platform: "pinterest";
      boardId?: string;
      destinationUrl?: string;
      title?: string;
      coverImageUrl?: string;
    }
  | { platform: "threads"; replyToId?: string }
  | {
      platform: "tiktok";
      privacy?: "public_to_everyone" | "mutual_follow_friend" | "self_only";
      disableComment?: boolean;
      disableDuet?: boolean;
      disableStitch?: boolean;
      brandContentToggle?: boolean;
      brandOrganicToggle?: boolean;
    }
  | {
      platform: "bluesky";
      replyToUri?: string;
      replyToCid?: string;
      replyRootUri?: string;
      replyRootCid?: string;
    }
  | { platform: "facebook" }
  | { platform: "instagram" }
  | { platform: "linkedin" };

export interface PostTarget {
  accountId?: string;
  platform?: Platform;
  text?: string;
  media?: MediaInput[];
  firstComment?: FirstComment;
  options?: TargetOptions;
}

export interface CreatePostRequest {
  targets: PostTarget[];
  text?: string;
  media?: MediaInput[];
  firstComment?: FirstComment;
  publishNow?: boolean;
  scheduledAt?: string;
  profileId?: string;
}

export interface PostTargetResult {
  accountId: string;
  platform: Platform;
  postId?: string;
  status: PostStatus;
  uri?: string;
  cid?: string;
  firstCommentUri?: string;
  firstCommentCid?: string;
  warnings?: Array<{ code: string; message: string }>;
  error?: {
    code: ErrorCode | string;
    message: string;
    rule?: string;
    remediation?: string;
    platformResponse?: unknown;
  };
}

export interface CreatePostResponse {
  id: string;
  status: BatchStatus;
  createdAt: string;
  scheduledAt?: string;
  results: PostTargetResult[];
}

export interface Post {
  id: string;
  profileId: string;
  accountId: string;
  account: {
    id: string;
    platform: Platform;
    platformAccountId: string;
    displayName: string | null;
  };
  platform: Platform;
  status: PostStatus;
  text: string;
  mediaRefs: unknown[];
  scheduledAt: string | null;
  publishedAt: string | null;
  platformUri: string | null;
  platformCid: string | null;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PostAttempt {
  id: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  succeeded: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  platformResponse?: unknown;
}

export type PostDetail = Post & { attempts: PostAttempt[] };

export interface ListPostsParams {
  profileId?: string;
  platform?: Platform | Platform[];
  status?: PostStatus | PostStatus[];
  errorCode?: string | string[];
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
}

export interface PostListResponse {
  data: Post[];
  nextCursor: string | null;
}

export class PostsResource {
  constructor(private readonly http: HttpClient) {}

  create(body: CreatePostRequest, opts?: RequestOptions): Promise<CreatePostResponse> {
    return this.http.request<CreatePostResponse>(
      { method: "POST", path: "/v1/posts", body },
      opts ?? {},
    );
  }

  list(params: ListPostsParams = {}, opts?: RequestOptions): Promise<PostListResponse> {
    return this.http.request<PostListResponse>(
      { method: "GET", path: "/v1/posts", query: params as Record<string, unknown> },
      opts ?? {},
    );
  }

  get(id: string, opts?: RequestOptions): Promise<PostDetail> {
    return this.http.request<PostDetail>(
      { method: "GET", path: `/v1/posts/${encodeURIComponent(id)}` },
      opts ?? {},
    );
  }
}
