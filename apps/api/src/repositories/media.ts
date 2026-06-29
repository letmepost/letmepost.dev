import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { DrizzleClient } from "../db/index.js";
import { media, type Media } from "../db/schema/media.js";

export type CreateMediaInput = {
  /** Pre-generated id — caller controls because the S3 key needs the same value. */
  id: string;
  organizationId: string;
  profileId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  s3Key: string;
};

export type ListMediaFilters = {
  organizationId: string;
  /** When set, scope to a specific profile; otherwise list all org media. */
  profileId?: string;
};

export type ListMediaOptions = {
  /** Page size. Repo clamps to [1, 100]. */
  limit?: number;
  /**
   * Opaque cursor from a previous response — encodes (createdAt, id) of the
   * last row on the previous page so we can keyset-paginate.
   */
  cursor?: string;
};

export type ListMediaResult = {
  data: Media[];
  nextCursor: string | null;
};

export interface MediaRepository {
  create(input: CreateMediaInput): Promise<Media>;
  /**
   * Org-scoped lookup. Routes that already have a profileId in scope should
   * use `findByIdScoped` instead — this is for plumbing that only knows the
   * org (e.g. the post resolver after the api-key check).
   */
  findById(organizationId: string, id: string): Promise<Media | null>;
  findByIdScoped(args: {
    organizationId: string;
    profileId: string;
    id: string;
  }): Promise<Media | null>;
  list(
    filters: ListMediaFilters,
    opts?: ListMediaOptions,
  ): Promise<ListMediaResult>;
}

export class DrizzleMediaRepository implements MediaRepository {
  constructor(private readonly db: DrizzleClient) {}

  async create(input: CreateMediaInput): Promise<Media> {
    const [row] = await this.db
      .insert(media)
      .values({
        id: input.id,
        organizationId: input.organizationId,
        profileId: input.profileId,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        s3Key: input.s3Key,
      })
      .returning();
    if (!row) throw new Error("media.create returned no row");
    return row;
  }

  async findById(organizationId: string, id: string): Promise<Media | null> {
    const rows = await this.db
      .select()
      .from(media)
      .where(and(eq(media.id, id), eq(media.organizationId, organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByIdScoped(args: {
    organizationId: string;
    profileId: string;
    id: string;
  }): Promise<Media | null> {
    const rows = await this.db
      .select()
      .from(media)
      .where(
        and(
          eq(media.id, args.id),
          eq(media.organizationId, args.organizationId),
          eq(media.profileId, args.profileId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    filters: ListMediaFilters,
    opts: ListMediaOptions = {},
  ): Promise<ListMediaResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const conds = [eq(media.organizationId, filters.organizationId)];
    if (filters.profileId) {
      conds.push(eq(media.profileId, filters.profileId));
    }

    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (decoded) {
        // Keyset pagination on (createdAt desc, id desc) — strict less-than
        // tuple comparison, expressed as: createdAt < cursor.createdAt OR
        // (createdAt = cursor.createdAt AND id < cursor.id).
        const boundary = sql`${decoded.createdAtText}::timestamptz`;
        conds.push(
          or(
            lt(media.createdAt, boundary),
            and(eq(media.createdAt, boundary), lt(media.id, decoded.id)),
          )!,
        );
      }
    }

    const rows = await this.db
      .select({
        row: media,
        createdAtText: sql<string>`${media.createdAt}::text`,
      })
      .from(media)
      .where(and(...conds))
      .orderBy(desc(media.createdAt), desc(media.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.createdAtText, last.row.id) : null;
    return { data: page.map((r) => r.row), nextCursor };
  }
}

// Cursor format: base64url("{createdAt}:{id}"). createdAt is the raw Postgres
// timestamptz text (microsecond precision): a JS Date truncates to ms and
// breaks the keyset tie-breaker. Opaque to callers.
function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}:${id}`).toString("base64url");
}

function decodeCursor(
  cursor: string,
): { createdAtText: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    const createdAtText = decoded.slice(0, colon);
    const id = decoded.slice(colon + 1);
    if (createdAtText.length === 0 || id.length === 0) return null;
    return { createdAtText, id };
  } catch {
    return null;
  }
}

