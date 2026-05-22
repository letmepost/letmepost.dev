/**
 * Centralized query keys. Keep all keys here so invalidation can be
 * targeted (`queryClient.invalidateQueries({ queryKey: keys.posts.list() })`)
 * without grepping for stringly-typed tuples spread across the codebase.
 *
 * Keys for resources scoped to a profile take a `profileId` parameter so
 * each profile gets its own cache slot — switching profile flips the key
 * and TanStack Query auto-refetches. Pass `null`/`undefined` for "no profile
 * scope" (org-wide views, e.g. when listing api-keys without a filter).
 *
 * Top-level prefix invalidation (`["accounts"]`) matches every variant
 * underneath, so the profile provider can `invalidateQueries({ queryKey:
 * ["accounts"] })` on switch and catch all cached profile-scoped lists.
 */
export const queryKeys = {
  profiles: {
    list: () => ["profiles"] as const,
  },
  accounts: {
    list: (profileId: string | null = null) =>
      ["accounts", profileId] as const,
    pinterestBoards: (accountId: string) =>
      ["accounts", accountId, "pinterest", "boards"] as const,
  },
  apiKeys: {
    list: (profileId: string | null = null) => ["apiKeys", profileId] as const,
  },
  webhooks: {
    list: () => ["webhooks"] as const,
  },
  media: {
    list: () => ["media"] as const,
  },
  posts: {
    list: (filters: unknown) => ["posts", "list", filters] as const,
    detail: (id: string) => ["posts", "detail", id] as const,
  },
  billing: {
    subscription: () => ["billing", "subscription"] as const,
    usage: () => ["billing", "usage"] as const,
    invoices: () => ["billing", "invoices"] as const,
  },
} as const;
