import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { WEBHOOK_EVENT_TYPES, type WebhookEvent } from "@letmepost/schemas";
import { webhookEndpoints } from "../db/schema/webhook_endpoints.js";
import { LetmepostError } from "../errors.js";
import { idempotency } from "../middleware/idempotency.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { apiKeyOrSession } from "../middleware/api-key-or-session.js";
import { deliverWebhook } from "../webhooks/deliver.js";

const UrlSchema = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://") || u.startsWith("http://"), {
    message: "webhook URL must use http:// or https://",
  });

const EventsSchema = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .default([])
  .transform((arr) => Array.from(new Set(arr)));

const CreateEndpointRequest = z.object({
  url: UrlSchema,
  events: EventsSchema,
  description: z.string().max(500).optional(),
});

const UpdateEndpointRequest = z
  .object({
    url: UrlSchema.optional(),
    events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).optional(),
    active: z.boolean().optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided.",
  });

const TestDeliveryRequest = z
  .object({
    type: z.enum(WEBHOOK_EVENT_TYPES).default("post.published"),
    data: z.unknown().optional(),
  })
  .default({ type: "post.published" });

const SAMPLE_DATA: Record<string, unknown> = {
  postId: "00000000-0000-0000-0000-000000000000",
  platform: "bluesky",
  status: "published",
  text: "Test webhook from letmepost.dev — this is a synthetic event.",
  publishedAt: new Date().toISOString(),
  platformUri: "at://did:plc:test/app.bsky.feed.post/test",
};

function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function publicView(row: typeof webhookEndpoints.$inferSelect) {
  return {
    id: row.id,
    url: row.url,
    events: row.eventFilter,
    description: row.description,
    active: row.active,
    lastDeliveryAt: row.lastDeliveryAt,
    lastFailureReason: row.lastFailureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type WebhookEndpointRoutesOptions = {
  sessionMiddleware?: MiddlewareHandler;
};

export function createWebhookEndpointRoutes(
  options: WebhookEndpointRoutesOptions = {},
) {
  const app = new Hono();
  app.use("*", options.sessionMiddleware ?? apiKeyOrSession());
  app.use("*", rateLimit());
  app.use("*", idempotency());

  app.post(
    "/",
    zValidator("json", CreateEndpointRequest, (result) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          message: issue?.message ?? "Invalid request body.",
          rule: issue?.path.join(".") || "body",
          platformResponse: result.error.issues,
        });
      }
    }),
    async (c) => {
      const { url, events, description } = c.req.valid("json");
      const { organizationId } = c.var.apiKey;

      const signingSecret = generateSigningSecret();
      const [row] = await c.var.db
        .insert(webhookEndpoints)
        .values({
          organizationId,
          url,
          signingSecret,
          secretHash: hashSecret(signingSecret),
          eventFilter: events,
          ...(description !== undefined ? { description } : {}),
        })
        .returning();
      if (!row) {
        throw new LetmepostError({
          code: "internal_error",
          status: 500,
          message: "Failed to create webhook endpoint.",
        });
      }

      return c.json(
        {
          ...publicView(row),
          signingSecret,
        },
        201,
      );
    },
  );

  app.get("/", async (c) => {
    const { organizationId } = c.var.apiKey;
    const rows = await c.var.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, organizationId))
      .orderBy(desc(webhookEndpoints.createdAt));
    return c.json({ data: rows.map(publicView) });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const { organizationId } = c.var.apiKey;
    const [row] = await c.var.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Webhook endpoint not found.",
      });
    }
    return c.json(publicView(row));
  });

  app.patch(
    "/:id",
    zValidator("json", UpdateEndpointRequest, (result) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          message: issue?.message ?? "Invalid request body.",
          rule: issue?.path.join(".") || "body",
          platformResponse: result.error.issues,
        });
      }
    }),
    async (c) => {
      const id = c.req.param("id");
      const { organizationId } = c.var.apiKey;
      const patch = c.req.valid("json");

      const update: Partial<typeof webhookEndpoints.$inferInsert> = {};
      if (patch.url !== undefined) update.url = patch.url;
      if (patch.events !== undefined) {
        update.eventFilter = Array.from(new Set(patch.events));
      }
      if (patch.active !== undefined) {
        update.active = patch.active;
        update.disabledAt = patch.active ? null : new Date();
      }
      if (patch.description !== undefined) {
        update.description = patch.description;
      }

      const [row] = await c.var.db
        .update(webhookEndpoints)
        .set(update)
        .where(
          and(
            eq(webhookEndpoints.id, id),
            eq(webhookEndpoints.organizationId, organizationId),
          ),
        )
        .returning();

      if (!row) {
        throw new LetmepostError({
          code: "not_found",
          status: 404,
          message: "Webhook endpoint not found.",
        });
      }

      return c.json(publicView(row));
    },
  );

  // Synchronous on purpose — operators want immediate "did my handler 200?"
  // feedback, not queued delivery.
  app.post(
    "/:id/test",
    zValidator("json", TestDeliveryRequest, (result) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new LetmepostError({
          code: "validation_failed",
          status: 400,
          message: issue?.message ?? "Invalid request body.",
          rule: issue?.path.join(".") || "body",
          platformResponse: result.error.issues,
        });
      }
    }),
    async (c) => {
      const id = c.req.param("id");
      const { organizationId } = c.var.apiKey;
      const { type, data } = c.req.valid("json");

      const [row] = await c.var.db
        .select()
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, id),
            eq(webhookEndpoints.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new LetmepostError({
          code: "not_found",
          status: 404,
          message: "Webhook endpoint not found.",
        });
      }

      const event: WebhookEvent = {
        id: randomUUID(),
        type,
        createdAt: new Date().toISOString(),
        organizationId,
        data: data ?? SAMPLE_DATA,
      };

      const result = await deliverWebhook(
        {
          id: row.id,
          url: row.url,
          signingSecret: row.signingSecret,
        },
        event,
      );

      return c.json({
        delivered: result.ok,
        status: result.status,
        durationMs: result.durationMs,
        responseBody: result.responseBody ?? null,
        deliveryId: result.deliveryId,
        nonRetryable: result.nonRetryable ?? false,
        errorName: result.errorName ?? null,
        sentEvent: event,
      });
    },
  );

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const { organizationId } = c.var.apiKey;

    const [row] = await c.var.db
      .delete(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.organizationId, organizationId),
        ),
      )
      .returning();

    if (!row) {
      throw new LetmepostError({
        code: "not_found",
        status: 404,
        message: "Webhook endpoint not found.",
      });
    }

    return c.json({ id: row.id, deleted: true });
  });

  return app;
}

/** Default export — uses real session auth. Mounted by `createApp`. */
export const webhookEndpointRoutes = createWebhookEndpointRoutes();
