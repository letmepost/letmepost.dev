import * as Sentry from "@sentry/node";

let initialized = false;

// Idempotent. Called from both server.ts and worker.ts so each process has
// its own Sentry hub. Skips entirely when SENTRY_DSN is unset, so local dev
// stays quiet and there's no behaviour change for self-hosters that don't
// opt in.
export function initSentry(component: "api" | "worker"): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "development",
    // Sample 100% of errors; trace at 10% which is enough on launch-day
    // traffic and cheap to dial up later.
    tracesSampleRate: Number.parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
    ),
    // Tag every event with which process produced it so the dashboard can
    // filter `web` vs `worker` failures without inspecting stack frames.
    initialScope: { tags: { component } },
  });
  initialized = true;
}

// Capture an unexpected error with optional metadata. LetmepostError is
// the expected envelope and gets a lower severity; everything else is
// fatal-worthy.
export function captureUnexpected(
  err: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context?.tags) scope.setTags(context.tags);
    if (context?.extra) scope.setExtras(context.extra);
    Sentry.captureException(err);
  });
}

export { Sentry };
