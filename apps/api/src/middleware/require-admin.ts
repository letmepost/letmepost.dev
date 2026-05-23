import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { member } from "../db/schema/auth.js";
import { LetmepostError } from "../errors.js";

// Members can read billing state (so they can see why a publish hit
// quota_exceeded) but only owners and admins can mutate it. Call this from
// the route handler that needs it, after the session middleware has run.
export async function requireAdmin(c: Context): Promise<void> {
  const { userId, organizationId } = c.var.session;
  const [row] = await c.var.db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row || (row.role !== "owner" && row.role !== "admin")) {
    throw new LetmepostError({
      code: "unauthorized",
      status: 403,
      message: "Only org owners and admins can manage billing.",
    });
  }
}

export function requireAdminMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await requireAdmin(c);
    await next();
  };
}
