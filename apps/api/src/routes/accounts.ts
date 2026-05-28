import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Platform } from "@letmepost/schemas";
import { profiles as profilesTable } from "../db/schema/profiles.js";
import { LetmepostError } from "../errors.js";
import { apiKeyOrSession } from "../middleware/api-key-or-session.js";
import { idempotency } from "../middleware/idempotency.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { requireSession } from "../middleware/session.js";
import { decodeOAuthState, encodeOAuthState } from "../oauth/state.js";
import { getProvider } from "../platforms/index.js";
import { PinterestClient } from "../platforms/pinterest/client.js";
import type { PinterestTokenMetadata } from "../platforms/pinterest/provider.js";
import type { InstagramAccountMetadataIgLogin } from "../platforms/instagram/provider.js";
import {
  assertPlatformEnabled,
  platformState,
} from "../platforms/_shared/platform-state.js";
import { computeRefreshDelayMs } from "../platforms/_shared/refresh.js";
import { DrizzlePlatformAccountsRepository } from "../repositories/platform-accounts.js";
import { DrizzleProfilesRepository } from "../repositories/profiles.js";

/**
 * `/v1/accounts` — connected social media accounts for the session's active
 * org. The wedge of Phase 5 is that `connect` / `complete` are generic across
 * platforms: each provider implements the `AccountProvider` contract and the
 * router just dispatches.
 *
 * Shape:
 *   POST /v1/accounts/connect/:platform           → returns a ConnectDescriptor
 *                                                     (OAuth URL for OAuth platforms,
 *                                                      form schema for Bluesky)
 *   POST /v1/accounts/connect/:platform/complete  → finishes the handshake;
 *                                                     upserts platform_accounts
 *   GET  /v1/accounts                             → list (no secrets)
 *   GET  /v1/accounts/:id                         → detail (no secrets)
 *   DELETE /v1/accounts/:id                       → hard delete
 *
 * Secrets are NEVER returned from any endpoint — only the display name,
 * platform, platformAccountId, and lifecycle timestamps leak out.
 */

const PlatformParam = z.object({ platform: Platform });

function publicView(account: {
  id: string;
  profileId: string;
  platform: string;
  platformAccountId: string;
  displayName: string | null;
  tokenExpiresAt: Date | null;
  tokenMetadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const base = {
    id: account.id,
    profileId: account.profileId,
    platform: account.platform,
    platformAccountId: account.platformAccountId,
    displayName: account.displayName,
    tokenExpiresAt: account.tokenExpiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
  // Platform-specific public extensions. Only non-secret fields surface
  // here — refresh tokens, scopes, and similar stay in tokenMetadata and
  // never leak. Adding a new platform's public fields = add a new branch.
  if (account.platform === "pinterest") {
    const meta = (account.tokenMetadata ?? {}) as PinterestTokenMetadata;
    return {
      ...base,
      pinterest: {
        defaultBoardId: meta.defaultBoardId ?? null,
        defaultBoardName: meta.defaultBoardName ?? null,
      },
    };
  }
  if (account.platform === "instagram") {
    // Surface the non-secret IG metadata so the dashboard (and lmp-test) can
    // diagnose connect-vs-publish mismatches without dumping tokens. The
    // common failure mode is "OAuth completes but publish fails" — usually
    // because the user unticked `instagram_business_content_publish` at the
    // consent screen, or because the account type isn't a Professional one.
    // `grantedScopes` is what Meta actually echoed back; `accountType` is
    // what Meta reports on `GET /me`. Neither is sensitive.
    const meta = (account.tokenMetadata ?? {}) as Partial<
      InstagramAccountMetadataIgLogin & { kind?: string }
    >;
    return {
      ...base,
      instagram: {
        kind: meta.kind ?? null,
        accountType: meta.accountType ?? null,
        grantedScopes: meta.grantedScopes ?? null,
      },
    };
  }
  return base;
}

export type AccountRoutesOptions = {
  /** Test-only session middleware override (matches webhook-endpoints pattern). */
  sessionMiddleware?: MiddlewareHandler;
  /**
   * Public base URL used by providers to build OAuth redirect URIs. Defaults
   * to `PUBLIC_API_BASE_URL` env or `http://localhost:3000` for local dev.
   */
  baseUrl?: string;
  /**
   * Override for the refresh-token queue enqueuer. Tests pass a capturing
   * stub to assert the initial scheduled refresh was queued with the right
   * delay; production uses the BullMQ-backed default (lazily imported so
   * this route module doesn't open a Redis connection at import time).
   */
  refreshEnqueuer?: import("../queue/refresh-enqueue.js").TokenRefreshEnqueuer;
};

/**
 * Allowlist `returnTo` URLs to the same origins we accept as session
 * trusted-origins. Anything else returns null so the caller falls back to
 * the default /accounts redirect. This blocks open-redirect attacks where
 * a malicious page initiates a connect with `returnTo=https://evil.com`
 * and hijacks the user post-callback.
 *
 * Same path the dashboard sends is preserved; only the origin is locked
 * down.
 */
function validateReturnTo(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const allowed = new Set<string>();
  const dashboard = process.env.DASHBOARD_URL;
  if (dashboard) {
    try {
      allowed.add(new URL(dashboard).origin);
    } catch {
      /* ignore */
    }
  }
  const trusted = process.env.TRUSTED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of trusted ?? []) {
    try {
      allowed.add(new URL(origin).origin);
    } catch {
      /* ignore */
    }
  }
  // Local dev fallback so the marketing-site demo on :3000 works when
  // running the stack locally without setting envs.
  if (allowed.size === 0) {
    allowed.add("http://localhost:3001");
    allowed.add("http://localhost:3000");
  }
  return allowed.has(parsed.origin) ? parsed.toString() : null;
}

export function createAccountRoutes(options: AccountRoutesOptions = {}) {
  const app = new Hono();
  // Auth is per-route below: writes (connect / disconnect) require a
  // dashboard session; reads accept either Bearer or session so programmatic
  // consumers can list accounts to find an id to publish against.
  const session = options.sessionMiddleware ?? requireSession();
  const dual = apiKeyOrSession();
  app.use("*", rateLimit());
  app.use("*", idempotency());

  const baseUrl =
    options.baseUrl ??
    process.env.PUBLIC_API_BASE_URL ??
    "http://localhost:3000";

  async function scheduleInitialRefresh(params: {
    accountId: string;
    organizationId: string;
    horizonMs: number;
    tokenExpiresAt: Date | null;
  }): Promise<void> {
    const delay = computeRefreshDelayMs(
      { tokenExpiresAt: params.tokenExpiresAt },
      params.horizonMs,
    );
    if (delay === null) return;
    const enqueuer =
      options.refreshEnqueuer ??
      (await import("../queue/refresh-enqueue.js")).createDefaultTokenRefreshEnqueuer();
    await enqueuer
      .enqueue(
        {
          platformAccountId: params.accountId,
          organizationId: params.organizationId,
        },
        { delayMs: delay },
      )
      .catch((err: unknown) => {
        // A failed refresh schedule shouldn't break the connect flow — the
        // account is saved; worst case we re-auth lazily on next publish.
        console.error("[accounts] refresh schedule failed", err);
      });
  }

  /** POST /v1/accounts/connect/:platform — describe how to connect. */
  app.post(
    "/connect/:platform",
    session,
    zValidator("param", PlatformParam, (result) => {
      if (!result.success) {
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          message: "Unknown platform.",
          rule: "platform",
          platformResponse: result.error.issues,
        });
      }
    }),
    async (c) => {
      const { platform } = c.req.valid("param");
      // Gate: reject `pending` platforms with a transparent
      // `platform_not_enabled` error. `trial` falls through (the
      // dashboard badges the tile separately).
      assertPlatformEnabled(platform);
      const provider = getProvider(platform);
      const { organizationId } = c.var.session;

      // Optional profile scope + returnTo for OAuth. Profile lands the new
      // account in the right bucket; returnTo overrides the post-callback
      // redirect so callers can ship users back to where they came from
      // (dashboard home, marketing demo page, etc.) instead of the static
      // /accounts page.
      const body = (await c.req.json().catch(() => ({}))) as
        | { profileId?: unknown; returnTo?: unknown }
        | undefined;
      const requestedProfileId =
        body && typeof body.profileId === "string" ? body.profileId : null;
      // Validate the profile if supplied (cross-org / unknown → 404).
      const profileId = requestedProfileId
        ? await resolveProfileId(c.var.db, organizationId, requestedProfileId)
        : null;

      const returnTo =
        body && typeof body.returnTo === "string"
          ? validateReturnTo(body.returnTo)
          : null;

      // Sign a state token carrying the org/profile/platform context. The
      // GET callback recovers this from the URL after the platform redirects
      // back, so we don't need a server-side session lookup at that point.
      //
      // PKCE providers (Twitter) re-sign this themselves to embed
      // `pkce.codeVerifier` — the dashboard does a full-page redirect right
      // after this call, so the verifier can't ride client-side state.
      // Passing the raw payload alongside the pre-signed token lets PKCE
      // providers compose without introducing a separate code path.
      const oauthStatePayload = {
        organizationId,
        profileId,
        platform,
        ...(returnTo ? { returnTo } : {}),
      };
      const oauthState = encodeOAuthState(oauthStatePayload);

      const descriptor = await provider.describeConnect({
        organizationId,
        baseUrl,
        oauthState,
        oauthStatePayload,
      });
      return c.json({
        platform,
        state: platformState(platform),
        descriptor,
      });
    },
  );

  /** POST /v1/accounts/connect/:platform/complete — finish the connect. */
  app.post(
    "/connect/:platform/complete",
    session,
    zValidator("param", PlatformParam, (result) => {
      if (!result.success) {
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          message: "Unknown platform.",
          rule: "platform",
          platformResponse: result.error.issues,
        });
      }
    }),
    async (c) => {
      const { platform } = c.req.valid("param");
      // Gate /complete as well — a determined caller could try to POST
      // here directly with hand-crafted credentials even if /connect
      // was blocked. Keeps the rejection consistent across both halves
      // of the handshake.
      assertPlatformEnabled(platform);
      const provider = getProvider(platform);
      const { organizationId } = c.var.session;

      const body = (await c.req.json().catch(() => ({}))) as
        | { profileId?: unknown }
        | undefined;
      const requestedProfileId =
        body && typeof body.profileId === "string" ? body.profileId : null;

      const profileId = await resolveProfileId(c.var.db, organizationId, requestedProfileId);

      const connectedRaw = await provider.completeConnect(
        { organizationId, baseUrl },
        body,
      );
      // Credentials providers (Bluesky) always return a single record. The
      // POST /complete path is the credentials surface; OAuth fan-out
      // happens on the GET callback. If a credentials provider ever
      // returns an array here, treat the first as primary — matches the
      // user's mental model ("connect this account").
      const connected = Array.isArray(connectedRaw)
        ? connectedRaw[0]
        : connectedRaw;
      if (!connected) {
        throw new LetmepostError({
          code: "internal_error",
          status: 500,
          message: "Provider returned no account on completeConnect.",
        });
      }

      const repo = new DrizzlePlatformAccountsRepository(c.var.db);
      const existing = await repo.findByOrgAndPlatform(
        organizationId,
        platform,
        connected.platformAccountId,
      );

      // Upsert semantics: re-connecting the same account rotates the stored
      // token and metadata rather than creating a duplicate row. The UNIQUE
      // index on (org, platform, platformAccountId) would otherwise 409.
      if (existing) {
        const updated = await repo.updateToken(existing.id, {
          token: connected.token,
          tokenMetadata: connected.tokenMetadata,
          tokenExpiresAt: connected.tokenExpiresAt,
        });
        await scheduleInitialRefresh({
          accountId: updated.id,
          organizationId,
          horizonMs: provider.expiringHorizonMs,
          tokenExpiresAt: updated.tokenExpiresAt,
        });
        return c.json(publicView(updated));
      }

      const created = await repo.create({
        organizationId,
        profileId,
        platform,
        platformAccountId: connected.platformAccountId,
        displayName: connected.displayName,
        token: connected.token,
        tokenMetadata: connected.tokenMetadata,
        tokenExpiresAt: connected.tokenExpiresAt,
      });
      await scheduleInitialRefresh({
        accountId: created.id,
        organizationId,
        horizonMs: provider.expiringHorizonMs,
        tokenExpiresAt: created.tokenExpiresAt,
      });
      return c.json(publicView(created), 201);
    },
  );

  /** GET /v1/accounts — list. Bearer or session; orgId comes off c.var.apiKey
   *  (set on both auth paths by `apiKeyOrSession`).
   *
   *  Optional `?profileId=<uuid>` narrows to a single profile — used by
   *  the dashboard's profile switcher. Omitting it preserves the legacy
   *  org-wide list for direct API consumers. We don't fail when the
   *  profileId looks malformed; we just match nothing, which is safer
   *  than a 400 surfacing as a broken dashboard tab. */
  app.get("/", dual, async (c) => {
    const { organizationId } = c.var.apiKey;
    const profileIdParam = c.req.query("profileId");
    const profileId =
      typeof profileIdParam === "string" && profileIdParam.length > 0
        ? profileIdParam
        : null;
    const repo = new DrizzlePlatformAccountsRepository(c.var.db);
    const rows = await repo.listByOrgAndProfile(organizationId, profileId);
    return c.json({ data: rows.map(publicView) });
  });

  /** GET /v1/accounts/:id — detail (no secret). Bearer or session. */
  app.get("/:id", dual, async (c) => {
    const id = c.req.param("id");
    const { organizationId } = c.var.apiKey;
    const repo = new DrizzlePlatformAccountsRepository(c.var.db);
    const account = await repo.findById(id);
    if (!account || account.organizationId !== organizationId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Platform account not found.",
      });
    }
    return c.json(publicView(account));
  });

  /** DELETE /v1/accounts/:id — hard delete. Session-only (admin op). */
  app.delete("/:id", session, async (c) => {
    const id = c.req.param("id");
    const { organizationId } = c.var.session;
    const repo = new DrizzlePlatformAccountsRepository(c.var.db);

    const account = await repo.findById(id);
    if (!account || account.organizationId !== organizationId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Platform account not found.",
      });
    }

    const deleted = await repo.delete(id);
    if (!deleted) {
      throw new LetmepostError({
        code: "internal_error",
        status: 500,
        message: "Failed to delete platform account.",
      });
    }

    return c.json({ id, deleted: true });
  });

  /**
   * POST /v1/accounts/:id/pinterest/boards — create a board on the user's
   * Pinterest account. Recovers from the boardless-connect dead-end without
   * forcing the user to leave for pinterest.com. Optional `setAsDefault`
   * lifts the new board into `tokenMetadata.defaultBoardId` in one round-trip.
   */
  const PinterestCreateBoardBody = z.object({
    name: z.string().min(1).max(180),
    description: z.string().max(500).optional(),
    privacy: z.enum(["PUBLIC", "PROTECTED", "SECRET"]).optional(),
    /** When true, the new board's id lands as the account's default. */
    setAsDefault: z.boolean().optional(),
    /**
     * Idempotent mode. If a board with the same name already exists, return
     * it (with `existing: true`) instead of failing with a duplicate-name
     * error. Lets callers write "ensure this board exists" without
     * orchestrating list-then-match-then-create themselves.
     */
    upsert: z.boolean().optional(),
  });
  app.post("/:id/pinterest/boards", dual, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PinterestCreateBoardBody.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: issue?.message ?? "Invalid body.",
        rule: issue?.path.join(".") || "body",
      });
    }
    const account = await loadPinterestAccount(c);
    const client = new PinterestClient(account.token);
    const repo = new DrizzlePlatformAccountsRepository(c.var.db);

    let created;
    try {
      created = await client.createBoard({
        name: parsed.data.name,
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        ...(parsed.data.privacy !== undefined
          ? { privacy: parsed.data.privacy }
          : {}),
      });
    } catch (err) {
      // Upsert recovery: Pinterest's duplicate-name error becomes a
      // lookup. We accept any platform_rejected whose upstream payload
      // smells like a duplicate (code 58 OR phrasing match).
      if (parsed.data.upsert && isPinterestDuplicateNameError(err)) {
        const all = await client.listBoards({ pageSize: 250 });
        const match = all.find(
          (b) => b.name.toLowerCase() === parsed.data.name.toLowerCase(),
        );
        if (match) {
          if (parsed.data.setAsDefault) {
            await repo.updateMetadata(account.id, {
              defaultBoardId: match.id,
              defaultBoardName: match.name,
            });
          }
          return c.json(
            {
              id: match.id,
              name: match.name,
              privacy: match.privacy ?? null,
              existing: true,
              ...(parsed.data.setAsDefault
                ? {
                    defaultBoardId: match.id,
                    defaultBoardName: match.name,
                  }
                : {}),
            },
            200,
          );
        }
        // Pinterest reports a duplicate but we can't find it in the user's
        // boards list. Most often a sandbox quirk (cross-environment name
        // uniqueness). Surface a more actionable error than the raw 409.
        throw new LetmepostError({
          code: "platform_rejected",
          status: 502,
          platform: "pinterest",
          message:
            "Pinterest reports a board with this name already exists, but it isn't in the user's boards list. This usually means the board lives in a different Pinterest environment (e.g. production vs sandbox) — pick a different name.",
          rule: "pinterest.board.upsert_ghost",
          ...(err instanceof LetmepostError && err.platformResponse !== undefined
            ? { platformResponse: err.platformResponse }
            : {}),
        });
      }
      throw err;
    }

    if (parsed.data.setAsDefault) {
      await repo.updateMetadata(account.id, {
        defaultBoardId: created.id,
        defaultBoardName: created.name,
      });
    }

    return c.json(
      {
        id: created.id,
        name: created.name,
        privacy: created.privacy ?? null,
        existing: false,
        ...(parsed.data.setAsDefault
          ? { defaultBoardId: created.id, defaultBoardName: created.name }
          : {}),
      },
      201,
    );
  });

  /**
   * GET /v1/accounts/:id/pinterest/boards — proxy to /v5/boards using the
   * stored token. Used by the dashboard's default-board picker so the user
   * can see their actual boards (not just the first one Pinterest happened
   * to return at connect time).
   */
  app.get("/:id/pinterest/boards", dual, async (c) => {
    const account = await loadPinterestAccount(c);
    const client = new PinterestClient(account.token);
    const boards = await client.listBoards({ pageSize: 100 });
    return c.json({
      data: boards.map((b) => ({
        id: b.id,
        name: b.name,
        privacy: b.privacy ?? null,
      })),
      defaultBoardId:
        ((account.tokenMetadata ?? {}) as PinterestTokenMetadata)
          .defaultBoardId ?? null,
    });
  });

  /**
   * PATCH /v1/accounts/:id/pinterest/default-board — change which board
   * publishes consume when the request body omits `pinterest.boardId`.
   * Validates the board belongs to the user before persisting (so we don't
   * silently store a board id that 403s on next publish).
   */
  const PinterestDefaultBoardBody = z.object({
    boardId: z.string().min(1),
  });
  app.patch("/:id/pinterest/default-board", dual, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PinterestDefaultBoardBody.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: issue?.message ?? "Invalid body.",
        rule: issue?.path.join(".") || "body",
      });
    }
    const account = await loadPinterestAccount(c);
    const client = new PinterestClient(account.token);
    const boards = await client.listBoards({ pageSize: 100 });
    const match = boards.find((b) => b.id === parsed.data.boardId);
    if (!match) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Board not found on this Pinterest account.",
        rule: "pinterest.board.unknown",
        platform: "pinterest",
      });
    }
    const repo = new DrizzlePlatformAccountsRepository(c.var.db);
    const updated = await repo.updateMetadata(account.id, {
      defaultBoardId: match.id,
      defaultBoardName: match.name,
    });
    const meta = (updated.tokenMetadata ?? {}) as PinterestTokenMetadata;
    return c.json({
      id: updated.id,
      defaultBoardId: meta.defaultBoardId ?? null,
      defaultBoardName: meta.defaultBoardName ?? null,
    });
  });

  /**
   * GET /v1/accounts/oauth/:platform/callback — the OAuth provider's
   * redirect target. Anonymous (no auth middleware): the org/profile
   * context comes from the signed `state` query param that we minted in
   * POST /connect/:platform. After the token exchange + persistence, the
   * browser is redirected back to the dashboard with a status query.
   *
   * Failure modes all redirect (never JSON) — the user is in a browser
   * tab, not a fetch call:
   *   - provider returned ?error=…   → /accounts?connect_error=<reason>
   *   - state malformed/expired       → /accounts?connect_error=invalid_state
   *   - path platform ≠ state.platform → /accounts?connect_error=mismatch
   *   - completeConnect throws        → /accounts?connect_error=<code>
   *   - success                       → /accounts?connected=<platform>
   */
  app.get(
    "/oauth/:platform/callback",
    zValidator("param", PlatformParam, (result) => {
      if (!result.success) {
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          message: "Unknown platform.",
          rule: "platform",
        });
      }
    }),
    async (c) => {
      const { platform } = c.req.valid("param");
      const dashboardUrl = (
        process.env.DASHBOARD_URL ?? "http://localhost:3001"
      ).replace(/\/$/, "");

      // First-pass redirect target: the static /accounts page. If we
      // successfully decode the state and it carries a validated
      // returnTo, that overrides for subsequent redirects (both success
      // and error). The signed state guarantees the returnTo can't be
      // tampered with mid-flight.
      let redirectBase = `${dashboardUrl}/accounts`;
      const redirect = (qs: string) => {
        const sep = redirectBase.includes("?") ? "&" : "?";
        return c.redirect(`${redirectBase}${sep}${qs}`, 302);
      };

      const url = new URL(c.req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        return redirect(
          `connect_error=${encodeURIComponent(oauthError)}&platform=${platform}`,
        );
      }
      if (!code || !state) {
        return redirect(`connect_error=missing_params&platform=${platform}`);
      }

      // Recover org + profile + platform from the signed state.
      const decoded = decodeOAuthState(state);
      if (!decoded.ok) {
        return redirect(
          `connect_error=invalid_state_${decoded.reason}&platform=${platform}`,
        );
      }
      if (decoded.payload.platform !== platform) {
        return redirect(`connect_error=platform_mismatch&platform=${platform}`);
      }

      const { organizationId, profileId, pkce, returnTo } = decoded.payload;
      // Re-validate returnTo at callback time so a state token from a
      // previous env (different DASHBOARD_URL) can't redirect off-allowlist.
      const validatedReturnTo = returnTo ? validateReturnTo(returnTo) : null;
      if (validatedReturnTo) redirectBase = validatedReturnTo;
      const provider = getProvider(platform);
      const redirectUri = new URL(
        `/v1/accounts/oauth/${platform}/callback`,
        baseUrl,
      ).toString();

      // Server-side token exchange. Each provider's completeConnect knows
      // its own request shape; we just hand it { code, state, redirectUri }.
      // PKCE providers (Twitter) get the `codeVerifier` recovered from the
      // signed state — the dashboard can't keep it across the redirect.
      let connected;
      try {
        connected = await provider.completeConnect(
          { organizationId, baseUrl, oauthState: state },
          {
            code,
            state,
            redirectUri,
            ...(pkce?.codeVerifier
              ? { codeVerifier: pkce.codeVerifier }
              : {}),
          },
        );
      } catch (err) {
        // Always log the underlying detail — LetmepostError instances skip
        // the global error logger because they're "expected" responses, but
        // a connect-flow failure is something an operator wants to grep.
        const detail =
          err instanceof LetmepostError
            ? {
                code: err.code,
                rule: err.rule,
                platform: err.platform,
                message: err.message,
                platformResponse: err.platformResponse,
              }
            : err instanceof Error
              ? { message: err.message, stack: err.stack }
              : err;
        console.error(
          `[oauth/callback/${platform}] completeConnect failed`,
          detail,
        );
        const reason =
          err instanceof LetmepostError
            ? err.code
            : err instanceof Error
              ? "exchange_failed"
              : "exchange_failed";
        // Forward `rule` + `message` so the dashboard can render the actual
        // remediation instead of a generic "platform rejected" toast. Without
        // these the user sees a useless code and has no idea what to do —
        // exactly the silent-failure pattern this product exists to kill.
        const extras: string[] = [];
        if (err instanceof LetmepostError) {
          if (err.rule) {
            extras.push(`connect_rule=${encodeURIComponent(err.rule)}`);
          }
          if (err.message) {
            extras.push(`connect_message=${encodeURIComponent(err.message)}`);
          }
          if (err.remediation) {
            extras.push(
              `connect_remediation=${encodeURIComponent(err.remediation)}`,
            );
          }
        }
        const suffix = extras.length > 0 ? `&${extras.join("&")}` : "";
        return redirect(
          `connect_error=${encodeURIComponent(reason)}&platform=${platform}${suffix}`,
        );
      }

      // Resolve the target profile (default if none specified, else the
      // one the user picked at /connect time).
      const resolvedProfileId = await resolveProfileId(
        c.var.db,
        organizationId,
        profileId,
      );

      // Fan-out support: providers may return one or many. Meta's FBLB
      // grant produces one row per Page + one row per linked IG Business
      // account; every other provider returns a single record. Normalize
      // to an array up front so the upsert loop is uniform.
      const connectedList = Array.isArray(connected) ? connected : [connected];
      if (connectedList.length === 0) {
        return redirect(
          `connect_error=no_accounts_granted&platform=${platform}`,
        );
      }

      const repo = new DrizzlePlatformAccountsRepository(c.var.db);
      const persisted = [] as Array<{ id: string; platform: string }>;
      for (const entry of connectedList) {
        // Default to the connect-route's platform when fan-out doesn't
        // override (single-record providers leave .platform undefined).
        const targetPlatform = entry.platform ?? platform;
        const existing = await repo.findByOrgAndPlatform(
          organizationId,
          targetPlatform,
          entry.platformAccountId,
        );
        const account = existing
          ? await repo.updateToken(existing.id, {
              token: entry.token,
              tokenMetadata: entry.tokenMetadata,
              tokenExpiresAt: entry.tokenExpiresAt,
            })
          : await repo.create({
              organizationId,
              profileId: resolvedProfileId,
              platform: targetPlatform,
              platformAccountId: entry.platformAccountId,
              displayName: entry.displayName,
              token: entry.token,
              tokenMetadata: entry.tokenMetadata,
              tokenExpiresAt: entry.tokenExpiresAt,
            });

        await scheduleInitialRefresh({
          accountId: account.id,
          organizationId,
          horizonMs: provider.expiringHorizonMs,
          tokenExpiresAt: account.tokenExpiresAt,
        });

        persisted.push({ id: account.id, platform: targetPlatform });
      }

      return redirect(
        `connected=${platform}&accounts=${persisted.length}`,
      );
    },
  );

  /**
   * Resolve a Pinterest account scoped to the caller's org. Used by the
   * default-board endpoints to keep the path-id → account hydration in
   * one place. Returns the decrypted account so the caller can hand the
   * token to a PinterestClient.
   */
  async function loadPinterestAccount(c: import("hono").Context) {
    const id = c.req.param("id");
    if (!id) {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "Account id missing from URL.",
        rule: "id",
      });
    }
    const { organizationId } = c.var.apiKey;
    const repo = new DrizzlePlatformAccountsRepository(c.var.db);
    const account = await repo.findById(id);
    if (!account || account.organizationId !== organizationId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Platform account not found.",
      });
    }
    if (account.platform !== "pinterest") {
      throw new LetmepostError({
        code: "validation_failed",
        status: 400,
        message: "This endpoint is Pinterest-only.",
        rule: "platform.mismatch",
      });
    }
    return account;
  }

  return app;
}

/**
 * Sniff a Pinterest "duplicate board name" error out of whatever shape
 * `createBoard` threw. Pinterest's upstream payload uses code 58 for
 * duplicate names, and we also accept the wording in case Pinterest tweaks
 * the code.
 */
function isPinterestDuplicateNameError(err: unknown): boolean {
  if (!(err instanceof LetmepostError)) return false;
  if (err.code !== "platform_rejected") return false;
  if (err.platform !== "pinterest") return false;
  const resp = err.platformResponse;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    if (r.code === 58) return true;
    if (typeof r.message === "string") {
      const m = r.message.toLowerCase();
      if (m.includes("already have a board") || m.includes("already exists")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolve the profile a connect/complete should land in.
 *
 *  - If the caller supplied a `profileId` in the body, verify it belongs to
 *    the same org and use it.
 *  - Otherwise, fall back to the org's "Default" profile (slug=`default`),
 *    which sign-up creates automatically.
 *
 * Throws `validation_failed` (400) for cross-org IDs, `not_found` (404) for
 * unknown IDs, and `internal_error` (500) if the org has no Default profile
 * (shouldn't happen — sign-up creates it; the migration backfilled it).
 */
async function resolveProfileId(
  db: import("../db/index.js").DrizzleClient,
  organizationId: string,
  requestedProfileId: string | null,
): Promise<string> {
  if (requestedProfileId) {
    const [row] = await db
      .select({ id: profilesTable.id, organizationId: profilesTable.organizationId })
      .from(profilesTable)
      .where(eq(profilesTable.id, requestedProfileId))
      .limit(1);
    if (!row) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Profile not found.",
        rule: "profile.unknown",
      });
    }
    if (row.organizationId !== organizationId) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Profile not found.",
        rule: "profile.cross_org",
      });
    }
    return row.id;
  }

  const repo = new DrizzleProfilesRepository(db);
  const def = await repo.findByOrgAndSlug(organizationId, "default");
  if (def) return def.id;

  // No Default profile — auto-create one. This shouldn't trigger after the
  // migration backfill, but it makes the connect flow resilient for orgs
  // created via paths that don't seed a Default (e.g. tests that build an
  // org by hand).
  const created = await repo.create({
    organizationId,
    name: "Default",
    slug: "default",
  });
  return created.id;
}

export const accountRoutes = createAccountRoutes();
