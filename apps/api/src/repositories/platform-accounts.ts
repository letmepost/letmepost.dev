import { and, eq } from "drizzle-orm";
import type { DrizzleClient } from "../db/index.js";
import {
  platformAccounts,
  type PlatformAccount as PlatformAccountRow,
} from "../db/schema/platform_accounts.js";
import { decrypt, encrypt } from "../encryption/envelope.js";

type Platform = PlatformAccountRow["platform"];

/**
 * Platform account as seen by callers — the raw `token` is plaintext (decrypted
 * on read). All envelope columns are stripped. Callers must never see ciphertext.
 */
export type DecryptedPlatformAccount = {
  id: string;
  organizationId: string;
  profileId: string;
  platform: Platform;
  platformAccountId: string;
  displayName: string | null;
  token: string;
  tokenMetadata: Record<string, unknown> | null;
  tokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreatePlatformAccountInput = {
  organizationId: string;
  profileId: string;
  platform: Platform;
  platformAccountId: string;
  displayName?: string | null;
  token: string;
  tokenMetadata?: Record<string, unknown> | null;
  tokenExpiresAt?: Date | null;
};

export type UpdatePlatformTokenInput = {
  token: string;
  tokenMetadata?: Record<string, unknown> | null;
  tokenExpiresAt?: Date | null;
};

/**
 * Result of `findUniqueAccountForPlatform`. Callers branch on `kind`:
 *   - `none`     → org has zero accounts for the platform; tell the caller to
 *                  connect one.
 *   - `unique`   → exactly one account; auto-resolution succeeded.
 *   - `ambiguous` → two or more; caller must disambiguate by passing an
 *                  explicit accountId. Candidate ids surface in the error so
 *                  the caller can echo them back.
 */
export type UniqueAccountLookup =
  | { kind: "none" }
  | { kind: "unique"; account: DecryptedPlatformAccount }
  | { kind: "ambiguous"; candidateIds: string[] };

export interface PlatformAccountsRepository {
  create(
    input: CreatePlatformAccountInput,
  ): Promise<DecryptedPlatformAccount>;
  findById(id: string): Promise<DecryptedPlatformAccount | null>;
  findByOrgAndPlatform(
    organizationId: string,
    platform: Platform,
    platformAccountId: string,
  ): Promise<DecryptedPlatformAccount | null>;
  /**
   * Resolve a target that named a platform but not a specific account.
   * Returns `none` / `unique` / `ambiguous` so the route can produce the
   * right `validation_failed` rule (or proceed with the resolved account).
   */
  findUniqueAccountForPlatform(
    organizationId: string,
    platform: Platform,
    profileId: string | null,
  ): Promise<UniqueAccountLookup>;
  listByOrg(organizationId: string): Promise<DecryptedPlatformAccount[]>;
  /**
   * Same as listByOrg but additionally narrows to a single profile —
   * scoped lists for the dashboard's profile switcher. Pass `null` for
   * the legacy "all profiles in this org" behavior; explicitly passing a
   * profileId returns only that profile's accounts.
   */
  listByOrgAndProfile(
    organizationId: string,
    profileId: string | null,
  ): Promise<DecryptedPlatformAccount[]>;
  delete(id: string): Promise<boolean>;
  updateToken(
    id: string,
    input: UpdatePlatformTokenInput,
  ): Promise<DecryptedPlatformAccount>;
  /**
   * Patch tokenMetadata WITHOUT rotating the token. Caller-supplied keys
   * are merged with the existing metadata; pass `null` to clear a key.
   */
  updateMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<DecryptedPlatformAccount>;
}

function hydrate(row: PlatformAccountRow): DecryptedPlatformAccount {
  const token = decrypt({
    ciphertext: row.tokenCiphertext,
    dekCiphertext: row.tokenDekCiphertext,
    iv: row.tokenIv,
    authTag: row.tokenAuthTag,
  });
  return {
    id: row.id,
    organizationId: row.organizationId,
    profileId: row.profileId,
    platform: row.platform,
    platformAccountId: row.platformAccountId,
    displayName: row.displayName,
    token,
    tokenMetadata: row.tokenMetadata ?? null,
    tokenExpiresAt: row.tokenExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzlePlatformAccountsRepository
  implements PlatformAccountsRepository
{
  constructor(private readonly db: DrizzleClient) {}

  async create(
    input: CreatePlatformAccountInput,
  ): Promise<DecryptedPlatformAccount> {
    const envelope = encrypt(input.token);
    const [row] = await this.db
      .insert(platformAccounts)
      .values({
        organizationId: input.organizationId,
        profileId: input.profileId,
        platform: input.platform,
        platformAccountId: input.platformAccountId,
        displayName: input.displayName ?? null,
        tokenCiphertext: envelope.ciphertext,
        tokenDekCiphertext: envelope.dekCiphertext,
        tokenIv: envelope.iv,
        tokenAuthTag: envelope.authTag,
        tokenMetadata: input.tokenMetadata ?? null,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
      })
      .returning();
    if (!row) throw new Error("platformAccounts.create returned no row");
    return hydrate(row);
  }

  async findById(id: string): Promise<DecryptedPlatformAccount | null> {
    const rows = await this.db
      .select()
      .from(platformAccounts)
      .where(eq(platformAccounts.id, id))
      .limit(1);
    const row = rows[0];
    return row ? hydrate(row) : null;
  }

  async findUniqueAccountForPlatform(
    organizationId: string,
    platform: Platform,
    profileId: string | null,
  ): Promise<UniqueAccountLookup> {
    // Profile scope: when the api key is profile-scoped, only that profile's
    // accounts are visible. A null profileId means the key is org-wide and
    // sees every account in the org regardless of profile. Without this
    // filter a profile-scoped key could enumerate sibling-profile accounts
    // via the `ambiguous` error's `candidates` payload.
    const scope = and(
      eq(platformAccounts.organizationId, organizationId),
      eq(platformAccounts.platform, platform),
      ...(profileId === null
        ? []
        : [eq(platformAccounts.profileId, profileId)]),
    );

    const rows = await this.db
      .select()
      .from(platformAccounts)
      .where(scope)
      .limit(2);
    if (rows.length === 0) return { kind: "none" };
    if (rows.length === 1) return { kind: "unique", account: hydrate(rows[0]!) };
    // Two rows came back from a LIMIT 2 → there are ≥2; fetch all ids so the
    // caller can echo them in `platformResponse.candidates`.
    const allIds = await this.db
      .select({ id: platformAccounts.id })
      .from(platformAccounts)
      .where(scope);
    return { kind: "ambiguous", candidateIds: allIds.map((r) => r.id) };
  }

  async findByOrgAndPlatform(
    organizationId: string,
    platform: Platform,
    platformAccountId: string,
  ): Promise<DecryptedPlatformAccount | null> {
    const rows = await this.db
      .select()
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.organizationId, organizationId),
          eq(platformAccounts.platform, platform),
          eq(platformAccounts.platformAccountId, platformAccountId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? hydrate(row) : null;
  }

  async listByOrg(
    organizationId: string,
  ): Promise<DecryptedPlatformAccount[]> {
    const rows = await this.db
      .select()
      .from(platformAccounts)
      .where(eq(platformAccounts.organizationId, organizationId));
    return rows.map(hydrate);
  }

  async listByOrgAndProfile(
    organizationId: string,
    profileId: string | null,
  ): Promise<DecryptedPlatformAccount[]> {
    if (profileId === null) return this.listByOrg(organizationId);
    const rows = await this.db
      .select()
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.organizationId, organizationId),
          eq(platformAccounts.profileId, profileId),
        ),
      );
    return rows.map(hydrate);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(platformAccounts)
      .where(eq(platformAccounts.id, id))
      .returning();
    return rows.length > 0;
  }

  async updateMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<DecryptedPlatformAccount> {
    const [existing] = await this.db
      .select({ tokenMetadata: platformAccounts.tokenMetadata })
      .from(platformAccounts)
      .where(eq(platformAccounts.id, id))
      .limit(1);
    if (!existing) {
      throw new Error(`platformAccounts.updateMetadata: no account with id=${id}`);
    }
    const current = (existing.tokenMetadata ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    const [row] = await this.db
      .update(platformAccounts)
      .set({ tokenMetadata: merged })
      .where(eq(platformAccounts.id, id))
      .returning();
    if (!row) {
      throw new Error(`platformAccounts.updateMetadata: no account with id=${id}`);
    }
    return hydrate(row);
  }

  async updateToken(
    id: string,
    input: UpdatePlatformTokenInput,
  ): Promise<DecryptedPlatformAccount> {
    const envelope = encrypt(input.token);
    const [row] = await this.db
      .update(platformAccounts)
      .set({
        tokenCiphertext: envelope.ciphertext,
        tokenDekCiphertext: envelope.dekCiphertext,
        tokenIv: envelope.iv,
        tokenAuthTag: envelope.authTag,
        ...(input.tokenMetadata !== undefined
          ? { tokenMetadata: input.tokenMetadata }
          : {}),
        ...(input.tokenExpiresAt !== undefined
          ? { tokenExpiresAt: input.tokenExpiresAt }
          : {}),
      })
      .where(eq(platformAccounts.id, id))
      .returning();
    if (!row) {
      throw new Error(`platformAccounts.updateToken: no account with id=${id}`);
    }
    return hydrate(row);
  }
}
