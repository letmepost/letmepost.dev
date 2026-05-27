// Next.js instrumentation hook. Runs once per process at startup, before
// any route handler. We use it to boot Sentry on the server and edge
// runtimes; the browser side is wired via `sentry.client.config.ts`.
// Skips entirely when SENTRY_DSN is unset so local dev stays quiet.
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  const runtime = process.env.NEXT_RUNTIME;
  if (runtime !== "nodejs" && runtime !== "edge") return;

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number.parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
    ),
    initialScope: { tags: { component: `dashboard-${runtime}` } },
  });
}

export const onRequestError = Sentry.captureRequestError;
