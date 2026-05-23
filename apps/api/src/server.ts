import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import {
  closeBillingInvalidation,
  startTierInvalidationListener,
} from "./billing/invalidate.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
// Bind to all interfaces so the platform's healthcheck (Railway, Fly, etc.)
// can reach us over the container's private IP. Defaulting to localhost
// only works for local dev where loopback is the right scope.
const hostname = process.env.HOST ?? "0.0.0.0";
const app = createApp();

// Subscribe to cross-process tier-cache invalidation so this pod sees
// plan changes published from any other pod (including the worker).
const stopTierListener = startTierInvalidationListener();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`[letmepost.dev] received ${signal}, shutting down…`);
  await stopTierListener().catch(() => {});
  await closeBillingInvalidation().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    `[letmepost.dev] api listening on http://${hostname}:${info.port}`,
  );
});
