// Sentry instrumentation loader. Runs in its OWN module graph before the
// app graph imports `http`, `postgres`, `bullmq`, etc., so OTel auto-
// instrumentations attach to the right symbols. Wired via:
//
//   node --import ./instrument.mjs ./dist/server.js
//   node --import ./instrument.mjs ./dist/queue/worker.js
//
// Reference: https://docs.sentry.io/platforms/javascript/guides/node/install/esm/

// Load .env BEFORE reading SENTRY_DSN. tsx watch / node --import runs
// instrument.mjs ahead of the app graph (which is where the app's own
// `import "dotenv/config"` lives), so the dev key would otherwise be
// invisible to Sentry init.
import "dotenv/config";
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number.parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
    ),
    initialScope: { tags: { runtime: "node" } },
  });
}
