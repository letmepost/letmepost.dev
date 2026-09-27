import type { NextConfig } from "next";
import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Pin Turbopack's workspace-root inference to the monorepo root. Without this
 * Next picks the home-directory-level `package-lock.json` and spews a warning
 * on every build. The root is two levels up from `apps/dashboard`.
 */
const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

// Wrap with Sentry so production builds upload source maps. Without this
// the client-side Sentry config still captures errors but you see
// minified frames in the dashboard. Inactive unless the three SENTRY_*
// auth env vars are set, so local builds and self-host stay quiet.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  disableLogger: false,
});
