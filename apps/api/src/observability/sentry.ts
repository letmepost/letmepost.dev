import * as Sentry from "@sentry/node";

// Capture an unexpected error with optional metadata. Init lives in the
// separate `instrument.mjs` loader (see node --import in the npm scripts);
// `Sentry.captureException` is a no-op when init was skipped, so this is
// safe to call from any code path without checking DSN configuration.
export function captureUnexpected(
  err: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  Sentry.withScope((scope) => {
    if (context?.tags) scope.setTags(context.tags);
    if (context?.extra) scope.setExtras(context.extra);
    Sentry.captureException(err);
  });
}

export { Sentry };
