import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { PostStatus } from "@letmepost/schemas";
import type { DrizzleClient } from "../db/index.js";
import { platformAccounts } from "../db/schema/platform_accounts.js";
import { postAttempts, type PostAttempt } from "../db/schema/post_attempts.js";
import { posts, type Post } from "../db/schema/posts.js";

export type CreatePostInput = {
  organizationId: string;
  accountId: string;
  text: string;
  status?: PostStatus;
  mediaRefs?: unknown[];
  scheduledAt?: Date | null;
};

export type UpdatePostStatusInput = {
  status: PostStatus;
  publishedAt?: Date | null;
  platformUri?: string | null;
  platformCid?: string | null;
  error?: Record<string, unknown> | null;
};

export type ListByOrgOptions = {
  limit?: number;
  /** Return rows with `createdAt` strictly before this cursor (descending pagination). */
  before?: Date;
};

export interface PostsRepository {
  create(input: CreatePostInput): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  updateStatus(id: string, input: UpdatePostStatusInput): Promise<Post>;
  listByOrg(organizationId: string, options?: ListByOrgOptions): Promise<Post[]>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class DrizzlePostsRepository implements PostsRepository {
  constructor(private readonly db: DrizzleClient) {}

  async create(input: CreatePostInput): Promise<Post> {
    const [row] = await this.db
      .insert(posts)
      .values({
        organizationId: input.organizationId,
        accountId: input.accountId,
        text: input.text,
        status: input.status ?? "queued",
        mediaRefs: input.mediaRefs ?? [],
        scheduledAt: input.scheduledAt ?? null,
      })
      .returning();
    if (!row) throw new Error("posts.create returned no row");
    return row;
  }

  async findById(id: string): Promise<Post | null> {
    const rows = await this.db
      .select()
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateStatus(
    id: string,
    input: UpdatePostStatusInput,
  ): Promise<Post> {
    const [row] = await this.db
      .update(posts)
      .set({
        status: input.status,
        ...(input.publishedAt !== undefined
          ? { publishedAt: input.publishedAt }
          : {}),
        ...(input.platformUri !== undefined
          ? { platformUri: input.platformUri }
          : {}),
        ...(input.platformCid !== undefined
          ? { platformCid: input.platformCid }
          : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      })
      .where(eq(posts.id, id))
      .returning();
    if (!row) throw new Error(`posts.updateStatus: no post with id=${id}`);
    return row;
  }

  async listByOrg(
    organizationId: string,
    options: ListByOrgOptions = {},
  ): Promise<Post[]> {
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const where = options.before
      ? and(
          eq(posts.organizationId, organizationId),
          lt(posts.createdAt, options.before),
        )
      : eq(posts.organizationId, organizationId);
    return this.db
      .select()
      .from(posts)
      .where(where)
      .orderBy(desc(posts.createdAt))
      .limit(limit);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * Post Log read repository
 * ─────────────────────────────────────────────────────────────────────────── */

export type PostListFilters = {
  organizationId: string;
  /** When set, only posts whose account is in that profile. */
  profileId?: string | null;
  platforms?: string[];
  statuses?: Post["status"][];
  /** Inclusive lower bound on `createdAt`. */
  after?: Date;
  /** Exclusive upper bound on `createdAt`. */
  before?: Date;
  errorCodes?: string[];
  /** Case-insensitive substring match on the post body (`posts.text`). */
  search?: string;
};

export type PostListPaging = {
  limit: number;
  /** Opaque cursor — use the value returned as `nextCursor` from a prior page. */
  cursor?: string;
};

export type PostAccountSummary = {
  id: string;
  profileId: string;
  platform: string;
  platformAccountId: string;
  displayName: string | null;
};

export type PostWithAccount = Post & { account: PostAccountSummary };

export type PostListResult = {
  data: PostWithAccount[];
  nextCursor: string | null;
};

/**
 * Cursor codec — opaque to callers. The boundary `createdAt` is carried at FULL
 * Postgres precision (ISO-8601 with 6-digit microseconds) rather than epoch
 * millis: Postgres timestamps have microsecond precision, and truncating to
 * milliseconds makes the keyset comparison miss rows tied on the same
 * millisecond (e.g. a multi-target batch inserted under one `now()`), silently
 * dropping posts across page boundaries. Format: `base64url("{iso}|{id}")`.
 */
export function encodeCursor(createdAtIso: string, id: string): string {
  return Buffer.from(`${createdAtIso}|${id}`).toString("base64url");
}

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function decodeCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep === -1) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!CURSOR_TS_RE.test(createdAt) || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface PostsReadRepository {
  list(
    filters: PostListFilters,
    paging: PostListPaging,
  ): Promise<PostListResult>;
  findByIdWithAccount(id: string): Promise<PostWithAccount | null>;
  attemptsFor(postId: string): Promise<PostAttempt[]>;
}

/**
 * Read-side queries for the Post Log. Pagination is keyset on
 * `(createdAt DESC, id DESC)` so the operator's "show me recent failures"
 * query stays fast as the table grows.
 */
export class DrizzlePostsReadRepository implements PostsReadRepository {
  constructor(private readonly db: DrizzleClient) {}

  async list(
    filters: PostListFilters,
    paging: PostListPaging,
  ): Promise<PostListResult> {
    const conditions = [eq(posts.organizationId, filters.organizationId)];

    if (filters.profileId) {
      conditions.push(eq(platformAccounts.profileId, filters.profileId));
    }

    if (filters.platforms && filters.platforms.length > 0) {
      // The DB platform enum is the wide one ("bluesky" | … | "pinterest");
      // we accept `string[]` at the boundary because the public Platform enum
      // is a strict subset and tests pass arbitrary strings.
      conditions.push(
        inArray(
          platformAccounts.platform,
          filters.platforms as readonly (typeof platformAccounts.platform.enumValues)[number][],
        ),
      );
    }

    if (filters.statuses && filters.statuses.length > 0) {
      conditions.push(inArray(posts.status, filters.statuses));
    }

    if (filters.after) {
      conditions.push(gte(posts.createdAt, filters.after));
    }
    if (filters.before) {
      conditions.push(lt(posts.createdAt, filters.before));
    }

    if (filters.errorCodes && filters.errorCodes.length > 0) {
      const codeExprs = filters.errorCodes.map(
        (code) => sql`${posts.error}->>'code' = ${code}`,
      );
      const head = codeExprs[0]!;
      conditions.push(
        codeExprs.length === 1 ? head : (or(...codeExprs) as typeof head),
      );
    }

    if (filters.search) {
      // Escape LIKE metacharacters so the term matches literally.
      const escaped = filters.search.replace(/[\\%_]/g, (m) => `\\${m}`);
      conditions.push(ilike(posts.text, `%${escaped}%`));
    }

    if (paging.cursor) {
      const decoded = decodeCursor(paging.cursor);
      if (decoded) {
        // Cast the cursor's microsecond ISO string back to timestamptz so the
        // keyset compares at the same precision the column stores — a Date bind
        // would truncate to milliseconds and skip rows on the boundary tick.
        conditions.push(
          or(
            sql`${posts.createdAt} < ${decoded.createdAt}::timestamptz`,
            and(
              sql`${posts.createdAt} = ${decoded.createdAt}::timestamptz`,
              lt(posts.id, decoded.id),
            ),
          )!,
        );
      }
    }

    // Over-fetch by 1 to detect "is there another page?" without a count query.
    const fetchLimit = Math.max(1, Math.min(paging.limit, 200)) + 1;

    const rows = await this.db
      .select({
        post: posts,
        account: {
          id: platformAccounts.id,
          profileId: platformAccounts.profileId,
          platform: platformAccounts.platform,
          platformAccountId: platformAccounts.platformAccountId,
          displayName: platformAccounts.displayName,
        },
        // Full-precision (microsecond) rendering of createdAt for the cursor —
        // `mode: "date"` truncates to milliseconds, so it can't feed the codec.
        cursorTs: sql<string>`to_char(${posts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(posts)
      .innerJoin(platformAccounts, eq(posts.accountId, platformAccounts.id))
      .where(and(...conditions))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(fetchLimit);

    const hasMore = rows.length === fetchLimit;
    const page = hasMore ? rows.slice(0, fetchLimit - 1) : rows;

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.cursorTs, last.post.id) : null;

    return {
      data: page.map((row) => ({ ...row.post, account: row.account })),
      nextCursor,
    };
  }

  async findByIdWithAccount(id: string): Promise<PostWithAccount | null> {
    const rows = await this.db
      .select({
        post: posts,
        account: {
          id: platformAccounts.id,
          profileId: platformAccounts.profileId,
          platform: platformAccounts.platform,
          platformAccountId: platformAccounts.platformAccountId,
          displayName: platformAccounts.displayName,
        },
      })
      .from(posts)
      .innerJoin(platformAccounts, eq(posts.accountId, platformAccounts.id))
      .where(eq(posts.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { ...row.post, account: row.account };
  }

  async attemptsFor(postId: string): Promise<PostAttempt[]> {
    return this.db
      .select()
      .from(postAttempts)
      .where(eq(postAttempts.postId, postId))
      .orderBy(postAttempts.attemptNumber);
  }
}
