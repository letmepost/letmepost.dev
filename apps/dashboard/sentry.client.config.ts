// Browser-side Sentry init. Loaded automatically by @sentry/nextjs when
// NEXT_PUBLIC_SENTRY_DSN is set; the file presence alone doesn't enable
// it, the DSN does, so dev builds without a key stay quiet.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENV ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number.parseFloat(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
    ),
    // Session replay only on errors. We're not paying for full-session
    // replay at launch; this captures the 10s before an error so we can
    // see what the user did to trigger it.
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
    initialScope: { tags: { component: "dashboard-browser" } },
  });
}
