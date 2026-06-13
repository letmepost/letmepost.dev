import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import type { DrizzleClient } from "./db/index.js";
import { db as defaultDb } from "./db/instance.js";
import { onError } from "./errors.js";
import { rateLimitHeaders } from "./middleware/rate-limit-headers.js";
import type { SessionContext } from "./middleware/session.js";
// Side-effect import: registers every v1 platform's AccountProvider so
// `/v1/accounts/:platform` can look them up by name.
import "./platforms/index.js";
import {
  createDefaultPublishEnqueuer,
  type PublishEnqueuer,
} from "./queue/enqueue.js";
import {
  accountRoutes,
  createAccountRoutes,
} from "./routes/accounts.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { attribution } from "./routes/attribution.js";
import { authRoutes } from "./routes/auth.js";
import {
  billingRoutes,
  createBillingRoutes,
} from "./routes/billing.js";
import { dataDeletion } from "./routes/data-deletion.js";
import { deauth } from "./routes/deauth.js";
import { health } from "./routes/health.js";
import { lemonSqueezy } from "./routes/lemonsqueezy.js";
import { resendWebhook } from "./routes/resend.js";
import { mcp } from "./routes/mcp.js";
import { media } from "./routes/media.js";
import { oauthExchange } from "./routes/oauth-exchange.js";
import { posts } from "./routes/posts.js";
import {
  createProfileRoutes,
  profileRoutes,
} from "./routes/profiles.js";
import { wellKnown } from "./routes/well-known.js";
import {
  createWebhookEndpointRoutes,
  webhookEndpointRoutes,
} from "./routes/webhook-endpoints.js";
import {
  createDefaultWebhookDispatcher,
  type WebhookDispatcher,
} from "./webhooks/dispatch.js";

declare module "hono" {
  interface ContextVariableMap {
    db: DrizzleClient;
    requestId: string;
    traceId?: string;
    webhookDispatcher: WebhookDispatcher;
    publishEnqueuer: PublishEnqueuer;
  }
}

export type AppOptions = {
  /** Override the Drizzle client — useful in tests to run inside a transaction. */
  db?: DrizzleClient;
  /**
   * Test-only: short-circuits `requireSession()` by pre-populating
   * `c.var.session` before any route middleware runs. Needed because
   * better-auth's `getSession` hits its own DB singleton and can't see inside
   * the per-test transaction used by the integration harness.
   */
  testSession?: SessionContext;
  /** Override the webhook dispatcher — tests pass a capturing stub to assert events. */
  webhookDispatcher?: WebhookDispatcher;
  /** Override the publish enqueuer — tests pass a capturing stub to assert delays. */
  publishEnqueuer?: PublishEnqueuer;
  /** Override the token-refresh enqueuer — tests pass a no-op to avoid Redis. */
  refreshEnqueuer?: import("./queue/refresh-enqueue.js").TokenRefreshEnqueuer;
};

export function createApp(options: AppOptions = {}) {
  const db = options.db ?? defaultDb;
  const webhookDispatcher =
    options.webhookDispatcher ?? createDefaultWebhookDispatcher(db);
  const publishEnqueuer =
    options.publishEnqueuer ?? createDefaultPublishEnqueuer();

  const app = new Hono();

  // Per-request correlation id — echoed in x-request-id and stamped on error bodies.
  app.use("*", requestId());

  // CORS for dashboard + future surfaces. Must allow credentials (better-auth
  // session cookie) and echo the origin exactly (never `*` with credentials).
  // Extra origins come from CORS_ORIGINS env, comma-separated.
  const corsOrigins = [
    "http://localhost:3001",
    ...(process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
  ];
  app.use(
    "*",
    cors({
      origin: (origin) => (corsOrigins.includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      exposeHeaders: [
        "X-Request-Id",
        "RateLimit-Limit",
        "RateLimit-Remaining",
        "RateLimit-Reset",
        "X-RateLimit-Limit",
      ],
      maxAge: 600,
    }),
  );

  // Emit X-RateLimit-* headers on every response (success AND error). Runs
  // before any auth so even an unauthenticated 401 surfaces the contract.
  app.use("*", rateLimitHeaders());

  // Make shared deps available to every downstream route / middleware.
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("webhookDispatcher", webhookDispatcher);
    c.set("publishEnqueuer", publishEnqueuer);
    await next();
  });

  // OAuth / OIDC discovery — must be mounted before /api/auth so the
  // .well-known surface is reachable at the root without basePath conflicts.
  // Clients walking the RFC 9728 hint hit /.well-known/* directly.
  app.route("/.well-known", wellKnown);

  app.route("/api/auth", authRoutes);
  // OAuth-token → API-key trade. Mounted before the session-only api-keys
  // routes so the global requireSession() middleware doesn't intercept.
  app.route("/v1/oauth-exchange", oauthExchange);
  app.route("/v1/api-keys", apiKeyRoutes);
  // First-touch attribution backfill for OAuth signups. Lives outside
  // the session-with-org gate because the user may not have an org yet
  // at the moment this is called (between OAuth callback and the org-
  // creation onboarding step).
  app.route("/v1/auth/attribution", attribution);

  if (options.testSession) {
    const session = options.testSession;
    const injectSession: MiddlewareHandler = async (c, next) => {
      c.set("session", session);
      c.set("apiKey", {
        organizationId: session.organizationId,
        apiKeyId: `session:${session.userId}`,
        scopes: ["posts:read", "posts:write"],
        profileId: null,
      });
      await next();
    };
    app.route(
      "/v1/webhook-endpoints",
      createWebhookEndpointRoutes({ sessionMiddleware: injectSession }),
    );
    app.route(
      "/v1/profiles",
      createProfileRoutes({ sessionMiddleware: injectSession }),
    );
    app.route(
      "/v1/accounts",
      createAccountRoutes({
        sessionMiddleware: injectSession,
        ...(options.refreshEnqueuer
          ? { refreshEnqueuer: options.refreshEnqueuer }
          : {}),
      }),
    );
    app.route(
      "/v1/billing",
      createBillingRoutes({ sessionMiddleware: injectSession }),
    );
  } else {
    app.route("/v1/webhook-endpoints", webhookEndpointRoutes);
    app.route("/v1/profiles", profileRoutes);
    if (options.refreshEnqueuer) {
      app.route(
        "/v1/accounts",
        createAccountRoutes({ refreshEnqueuer: options.refreshEnqueuer }),
      );
    } else {
      app.route("/v1/accounts", accountRoutes);
    }
    app.route("/v1/billing", billingRoutes);
  }

  app.route("/health", health);
  app.route("/posts", posts);
  app.route("/v1/posts", posts);
  // Inbound Lemon Squeezy webhooks. Public, signature-verified.
  app.route("/v1/lemonsqueezy", lemonSqueezy);
  // Inbound Resend webhooks (bounces / complaints). Public, signed via
  // Svix. Drives the email_suppressions table.
  app.route("/v1/resend", resendWebhook);
  app.route("/v1/media", media);
  // Hosted MCP endpoint. Streamable HTTP transport, stateless mode, gated
  // by the same API-key auth as /v1/*. Custom domain mcp.letmepost.dev
  // points at this Railway service via CNAME.
  app.route("/mcp", mcp);
  // Public, unauthenticated platform-callback endpoints. Not /v1-prefixed —
  // Meta calls these externally and we don't want to force a Meta config
  // update every time the customer-facing API version bumps.
  app.route("/data-deletion", dataDeletion);
  app.route("/deauth", deauth);
  app.onError(onError);
  return app;
}

export type App = ReturnType<typeof createApp>;
