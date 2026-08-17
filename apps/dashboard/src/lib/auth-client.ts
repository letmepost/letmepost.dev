"use client";

import { createAuthClient } from "better-auth/react";
import {
  inferAdditionalFields,
  organizationClient,
} from "better-auth/client/plugins";
import { API_URL } from "./env";

/**
 * Browser-side better-auth client. The API server is separately mounted at
 * `/api/auth`, so the client's `baseURL` points at the API origin (default
 * http://localhost:3000). The `organization` plugin surfaces the multi-tenant
 * endpoints (`authClient.organization.create`, `.setActive`, `.list`) we use
 * during sign-up and in the sidebar org switcher. `inferAdditionalFields`
 * teaches the client that `signUp.email` accepts our first-touch
 * attribution fields (kept in sync with `user.additionalFields` in
 * apps/api/src/auth.ts).
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: {
    credentials: "include",
  },
  plugins: [
    organizationClient(),
    inferAdditionalFields({
      user: {
        signupSource: { type: "string", required: false },
        signupUtmSource: { type: "string", required: false },
        signupUtmMedium: { type: "string", required: false },
        signupUtmCampaign: { type: "string", required: false },
        signupUtmContent: { type: "string", required: false },
        signupUtmTerm: { type: "string", required: false },
        signupReferrer: { type: "string", required: false },
        signupLandingPath: { type: "string", required: false },
      },
      session: {
        // Set only by the API's admin impersonation plugin; read by
        // ImpersonationBanner. Declared here so it stays typed on
        // `useSession().data.session`.
        impersonatedBy: { type: "string", required: false },
      },
    }),
  ],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  organization,
} = authClient;
