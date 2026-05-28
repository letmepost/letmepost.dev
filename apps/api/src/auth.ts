import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, organization } from "better-auth/plugins";
import { db } from "./db/instance.js";
import * as authSchema from "./db/schema/auth.js";
import * as oauthSchema from "./db/schema/oauth.js";
import { uuidv7 } from "./db/uuid.js";
import { emailEnabled, sendEmail } from "./email/client.js";
import { scheduleOnboardingEmails } from "./email/onboarding/schedule.js";

// Extract a first name from the better-auth `name` field for use in
// founder-voice email greetings. Trims first so leading whitespace
// doesn't produce a "" token before the fallback kicks in.
function pickFirstName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}

function buildSocialProviders() {
  const providers: Record<string, { clientId: string; clientSecret: string }> =
    {};

  const googleId = process.env.GOOGLE_CLIENT_ID;
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (googleId && googleSecret) {
    providers.google = { clientId: googleId, clientSecret: googleSecret };
  }

  const githubId = process.env.GITHUB_CLIENT_ID;
  const githubSecret = process.env.GITHUB_CLIENT_SECRET;
  if (githubId && githubSecret) {
    providers.github = { clientId: githubId, clientSecret: githubSecret };
  }

  return providers;
}

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 16) {
  throw new Error(
    "BETTER_AUTH_SECRET env var is not set or too short. Generate one with `openssl rand -base64 32` and add it to apps/api/.env.",
  );
}

/**
 * Trusted origins list. Local dev's dashboard (:3001) is always allowed;
 * production origins come in via `TRUSTED_ORIGINS` (comma-separated) so the
 * deploy can add `https://dashboard.letmepost.dev` without a code change.
 */
const trustedOrigins = [
  "http://localhost:3001",
  ...(process.env.TRUSTED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? []),
];

/**
 * Audiences the OAuth provider will mint access tokens for. The production
 * API origin is always valid; locally we also accept whatever `BETTER_AUTH_URL`
 * is pointing at so dev tokens validate against the dev API. JWT `aud` claim
 * must match exactly one of these or `verifyAccessToken` rejects the token.
 */
export const baseAuthUrl =
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
// MCP clients (Claude Code, Cursor, Claude Desktop) walk RFC 8707 — they
// pass `resource=https://api.letmepost.dev/mcp` on the token request,
// which becomes the JWT `aud`. So the resource URLs MUST also be in
// validAudiences or verifyAccessToken rejects with "requested resource
// invalid" on every tool call.
export const validAudiences = Array.from(
  new Set([
    "https://api.letmepost.dev",
    "https://api.letmepost.dev/mcp",
    baseAuthUrl,
    `${baseAuthUrl}/mcp`,
  ]),
);

/**
 * Cross-subdomain cookies. In production the API sits at api.letmepost.dev
 * and the dashboard at dashboard.letmepost.dev; the session cookie needs
 * `Domain=.letmepost.dev; SameSite=None; Secure` so both subdomains share
 * it. The COOKIE_DOMAIN env opts in (e.g. `.letmepost.dev`); leaving it
 * unset keeps dev behaviour single-origin (default cookie scope).
 */
const cookieDomain = process.env.COOKIE_DOMAIN;
const crossSubDomainCookies = cookieDomain
  ? {
      crossSubDomainCookies: {
        enabled: true,
        domain: cookieDomain,
      },
      defaultCookieAttributes: {
        sameSite: "none" as const,
        secure: true,
      },
    }
  : {};

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: authSchema.user,
      session: authSchema.session,
      account: authSchema.account,
      verification: authSchema.verification,
      organization: authSchema.organization,
      member: authSchema.member,
      invitation: authSchema.invitation,
      oauthClient: oauthSchema.oauthClient,
      oauthAccessToken: oauthSchema.oauthAccessToken,
      oauthRefreshToken: oauthSchema.oauthRefreshToken,
      oauthConsent: oauthSchema.oauthConsent,
      jwks: oauthSchema.jwks,
    },
  }),
  advanced: {
    database: {
      generateId: () => uuidv7(),
    },
    ...crossSubDomainCookies,
  },
  // Fires the founder-voice onboarding sequence ONCE per user, only after
  // the email has been verified. Two trigger points:
  //
  //   - user.create.after: OAuth signups arrive with emailVerified=true
  //     (Google/GitHub verify server-side), so they enqueue here.
  //   - user.update.after: email+password signups land with
  //     emailVerified=false, then flip to true after verification — we
  //     enqueue on that transition.
  //
  // Gating on verification stops a bad actor from spamming Resend with
  // throwaway addresses on launch day (hard bounces → sender reputation
  // hit → real emails start landing in spam).
  //
  // scheduleOnboardingEmails swallows its own errors internally — we
  // don't wrap with another .catch.
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const u = user as {
            email?: string;
            name?: string;
            emailVerified?: boolean;
          };
          if (!u.email || !u.emailVerified) return;
          void scheduleOnboardingEmails({
            userId: user.id,
            email: u.email,
            firstName: pickFirstName(u.name),
          });
        },
      },
      update: {
        after: async (user, context) => {
          const u = user as {
            email?: string;
            name?: string;
            emailVerified?: boolean;
          };
          if (!u.email || !u.emailVerified) return;
          // Only fire on the false → true transition. Without this guard
          // every profile update on a verified user would re-enqueue.
          const prev = (context as { previous?: { emailVerified?: boolean } })
            ?.previous;
          if (prev?.emailVerified === true) return;
          void scheduleOnboardingEmails({
            userId: user.id,
            email: u.email,
            firstName: pickFirstName(u.name),
          });
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    // Only enforce verification when Resend is wired. Self-host
    // instances without email infrastructure get a frictionless signup
    // (and never receive onboarding emails either — both gates flip
    // together on `emailEnabled`).
    requireEmailVerification: emailEnabled(),
  },
  emailVerification: {
    // Re-send a verification link on every signin attempt by an
    // unverified user. better-auth handles the token + redirect; we
    // only own the actual transport.
    sendOnSignIn: true,
    sendVerificationEmail: async ({ user, url }) => {
      const firstName = pickFirstName((user as { name?: string }).name);
      const replyTo = process.env.EMAIL_REPLY_TO ?? process.env.EMAIL_FROM;
      await sendEmail({
        to: user.email,
        subject: "verify your letmepost email",
        text: `Hey ${firstName},

Click this link to verify your email and finish setting up your letmepost account:

${url}

The link expires in an hour. If you didn't sign up for letmepost, ignore this. Nothing happens until the link is clicked.

Kamal`,
        ...(replyTo ? { replyTo } : {}),
        tag: "verification",
        // Don't add unsubscribe to a transactional, single-shot
        // verification email — users can't unsubscribe from a flow
        // they haven't opted into yet.
        withUnsubscribe: false,
      });
    },
  },
  account: {
    // Auto-link OAuth identities to an existing user when the verified
    // email matches. Without this, a user who signed up with email +
    // password and later clicks "Continue with GitHub" hits an
    // `account_not_linked` 400 because better-auth defaults to refusing
    // to merge accounts (defensive against confused-deputy attacks where
    // an attacker controls a provider that lies about emails).
    //
    // `trustedProviders` is the whitelist of providers we trust to have
    // verified the email server-side. Google and GitHub both verify
    // emails before issuing OIDC/OAuth identities, so it's safe to
    // auto-link from them. If we later add a provider that doesn't
    // (custom SAML, etc.) it must NOT go on this list.
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "github"],
      // Default is `true`, which refuses to link an incoming OAuth
      // identity to an existing account whose local `emailVerified` is
      // false — and our email/password signup never sets that field
      // (we don't send verification emails). The fix is to trust the
      // OAuth provider's `emailVerified` claim instead: Google and
      // GitHub both verify emails server-side before issuing OAuth
      // identities, so if a verified-OAuth email matches an existing
      // unverified local account, linking is safe.
      requireLocalEmailVerified: false,
    },
  },
  user: {
    // First-touch attribution. The dashboard collects these from URL params
    // + localStorage at signup time and passes them straight through to
    // better-auth. All optional — users who arrive without UTMs (typed the
    // URL, opened a saved tab) end up with nulls, which is correct.
    additionalFields: {
      signupSource: { type: "string", required: false, input: true },
      signupUtmSource: { type: "string", required: false, input: true },
      signupUtmMedium: { type: "string", required: false, input: true },
      signupUtmCampaign: { type: "string", required: false, input: true },
      signupUtmContent: { type: "string", required: false, input: true },
      signupUtmTerm: { type: "string", required: false, input: true },
      signupReferrer: { type: "string", required: false, input: true },
      signupLandingPath: { type: "string", required: false, input: true },
    },
  },
  socialProviders: buildSocialProviders(),
  plugins: [
    organization(),
    // JWT keypair store. The oauth-provider plugin signs access tokens with
    // these keys; the public half is served at /api/auth/jwks for resource
    // servers (us, here) to verify tokens without a network round-trip.
    jwt(),
    oauthProvider({
      // Dashboard pages the provider redirects to when it needs a logged-in
      // user (login) or a scope grant (consent). The dashboard lives on a
      // separate origin (dashboard.letmepost.dev in prod, localhost:3001 in
      // dev) so these MUST be absolute URLs — better-auth appends `?...signed
      // query...` and the user lands directly on the dashboard route.
      // DASHBOARD_URL is the configurable base; default keeps dev working.
      loginPage: `${process.env.DASHBOARD_URL ?? "http://localhost:3001"}/sign-in`,
      consentPage: `${process.env.DASHBOARD_URL ?? "http://localhost:3001"}/consent`,
      validAudiences,
      // Custom OAuth scopes:
      // - openid / profile / offline_access — standard OIDC bits the plugin
      //   needs for ID tokens + refresh.
      // - publish — write access to the MCP API surface (publish_post tool).
      // - read   — read-only access (list_posts, get_post, etc.).
      scopes: ["openid", "profile", "offline_access", "publish", "read"],
      // MCP clients (Claude Desktop, Cursor) self-register at install time via
      // RFC 7591. There's no out-of-band channel to pre-provision a client_id
      // so we accept unauthenticated registration; the consent screen is the
      // backstop that prevents drive-by clients from getting tokens.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Optional HMAC secret for pairwise subject identifiers — when set,
      // clients with `subject_type: "pairwise"` receive a per-client `sub`
      // instead of the raw user id. Off by default; turn on in prod when
      // PAIRWISE_SECRET is set.
      ...(process.env.PAIRWISE_SECRET
        ? { pairwiseSecret: process.env.PAIRWISE_SECRET }
        : {}),
    }),
  ],
  secret,
  baseURL: baseAuthUrl,
  trustedOrigins,
});

export type Auth = typeof auth;
