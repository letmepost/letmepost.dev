import { apiFetch } from "./api";

/**
 * Client mirror of the Post Log contract on the API. Kept loose-typed
 * (no zod) since this lives in a different bundle from the API server.
 * If a field comes back missing, render gracefully — the underlying
 * record might predate that field.
 */

export type PostStatus =
  | "queued"
  | "validated"
  | "publishing"
  | "published"
  | "failed"
  | "rejected"
  | "canceled";

export type PostError = {
  code: string;
  message?: string;
  rule?: string;
  platform?: string;
  platformVersion?: string;
  platformResponse?: unknown;
  remediation?: string;
};

export type PostAccountSummary = {
  id: string;
  platform: string;
  platformAccountId: string;
  displayName: string | null;
};

export type PostListItem = {
  id: string;
  profileId: string;
  accountId: string;
  account: PostAccountSummary;
  platform: string;
  status: PostStatus;
  text: string;
  mediaRefs: unknown[];
  scheduledAt: string | null;
  publishedAt: string | null;
  platformUri: string | null;
  platformCid: string | null;
  error: PostError | null;
  createdAt: string;
  updatedAt: string;
};

export type PostAttempt = {
  id: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  succeeded: boolean | null;
  errorCode: string | null;
  errorMessage: string | null;
  platformResponse: unknown;
};

export type PostDetail = PostListItem & {
  attempts: PostAttempt[];
};

export type PostListResponse = {
  data: PostListItem[];
  nextCursor: string | null;
};

export type ListPostsFilters = {
  profileId?: string;
  platform?: string[];
  status?: PostStatus[];
  errorCode?: string[];
  q?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
};

function buildQuery(f: ListPostsFilters): string {
  const params = new URLSearchParams();
  if (f.profileId) params.set("profileId", f.profileId);
  if (f.platform) for (const v of f.platform) params.append("platform", v);
  if (f.status) for (const v of f.status) params.append("status", v);
  if (f.errorCode) for (const v of f.errorCode) params.append("errorCode", v);
  if (f.q) params.set("q", f.q);
  if (f.after) params.set("after", f.after);
  if (f.before) params.set("before", f.before);
  if (f.limit !== undefined) params.set("limit", String(f.limit));
  if (f.cursor) params.set("cursor", f.cursor);
  const q = params.toString();
  return q.length > 0 ? `?${q}` : "";
}

export function listPosts(filters: ListPostsFilters = {}): Promise<PostListResponse> {
  return apiFetch<PostListResponse>(`/v1/posts${buildQuery(filters)}`);
}

export function getPost(id: string): Promise<PostDetail> {
  return apiFetch<PostDetail>(`/v1/posts/${id}`);
}

export function reschedulePost(
  id: string,
  scheduledAt: string,
): Promise<PostListItem> {
  return apiFetch<PostListItem>(`/v1/posts/${id}`, {
    method: "PATCH",
    body: { scheduledAt },
  });
}

export function cancelPost(id: string): Promise<{ id: string; status: "canceled" }> {
  return apiFetch<{ id: string; status: "canceled" }>(`/v1/posts/${id}`, {
    method: "DELETE",
  });
}

export const POST_STATUSES: PostStatus[] = [
  "queued",
  "validated",
  "publishing",
  "published",
  "failed",
  "rejected",
  "canceled",
];

/**
 * Canonical error codes the API emits across platforms. Mirrors the registry
 * in `packages/schemas/src/errors.ts`; adding a new code is a coordinated
 * change with the docs (Phase 13).
 */
export const POST_ERROR_CODES = [
  "preflight_failed",
  "platform_auth_failed",
  "platform_rejected",
  "platform_unavailable",
  "validation_failed",
  "internal_error",
] as const;

export type PostErrorCode = (typeof POST_ERROR_CODES)[number];

/** Compact relative-time formatter — "3m ago", "2h ago", "5d ago". */
export function formatRelative(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

/** Status → tone for badge coloring. */
export function statusTone(status: PostStatus):
  | "default"
  | "secondary"
  | "destructive"
  | "outline" {
  switch (status) {
    case "published":
      return "default";
    case "queued":
    case "publishing":
    case "validated":
      return "secondary";
    case "failed":
    case "rejected":
      return "destructive";
    default:
      return "outline";
  }
}
