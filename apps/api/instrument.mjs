// Sentry instrumentation loader. Runs in its OWN module graph before the
// app graph imports `http`, `postgres`, `bullmq`, etc., so OTel auto-
// instrumentations attach to the right symbols. Wired via:
//
//   node --import ./instrument.mjs ./dist/server.js
//   node --import ./instrument.mjs ./dist/queue/worker.js
//
// Side-effect imports inside the app graph (the old pattern) don't work
// for ESM because dependencies get hoisted before `Sentry.init` runs.
// Reference: https://docs.sentry.io/platforms/javascript/guides/node/install/esm/

import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  // Component tag is set on each event in code via withScope; we tag the
  // whole transport here with `runtime: node` so the dashboard can split
  // node vs browser at the project level without re-tagging each call.
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
