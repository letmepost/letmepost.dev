import * as Sentry from "@sentry/node";

// Capture an unexpected error with optional metadata. Init lives in the
// separate `instrument.mjs` loader (see node --import in the npm scripts);
// when DSN is unset, `captureException` short-circuits and never ships an
// event. The withScope callback still runs (cheap, all in-process), so
// the helper is not strictly free — just cheap enough to call from any
// path without conditional plumbing.
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
