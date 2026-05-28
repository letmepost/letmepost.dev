"use client";

import posthog from "posthog-js";

// `Platform` is wider than `@letmepost/schemas`'s Platform enum because
// analytics tracks intent (we want events ready when YouTube/TikTok land)
// while the backend enum tracks what's actually wired today.
export const ANALYTICS_PLATFORMS = [
  "bluesky",
  "linkedin",
  "twitter",
  "threads",
  "instagram",
  "facebook",
  "pinterest",
  "youtube",
  "tiktok",
] as const;
export type Platform = (typeof ANALYTICS_PLATFORMS)[number];

const PLATFORM_SET: ReadonlySet<string> = new Set(ANALYTICS_PLATFORMS);
export function asAnalyticsPlatform(p: string | null | undefined): Platform | null {
  return p && PLATFORM_SET.has(p) ? (p as Platform) : null;
}

export const ONBOARDING_STEPS = [
  "connect-account",
  "create-key",
  "first-post",
  "configure-webhook",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const ONBOARDING_STEP_SET: ReadonlySet<string> = new Set(ONBOARDING_STEPS);
export function asOnboardingStep(s: string): OnboardingStep | null {
  return ONBOARDING_STEP_SET.has(s) ? (s as OnboardingStep) : null;
}

type AuthProvider = "email" | "google" | "github";

type PostStatus =
  | "queued"
  | "validated"
  | "publishing"
  | "published"
  | "rejected"
  | "failed"
  | "canceled";

type WebhookEventType =
  | "post.queued"
  | "post.validated"
  | "post.published"
  | "post.rejected"
  | "post.failed"
  | "token.expiring"
  | "token.revoked"
  | "version.deprecated";

export type DashboardEvent =
  // ── Auth & onboarding ───────────────────────────────────────────────
  | {
      name: "signup.started";
      properties: {
        provider: AuthProvider;
        referrer?: string;
        // First-touch attribution snapshot taken from localStorage at the
        // moment the form is focused or an OAuth flow begins. Optional
        // because users who arrive directly (typed URL, bookmark) have
        // none of these.
        signup_source?: string;
        utm_source?: string;
        utm_medium?: string;
        utm_campaign?: string;
      };
    }
  | { name: "signup.completed"; properties: { provider: AuthProvider } }
  | { name: "signin.completed"; properties: { provider: AuthProvider } }
  | { name: "signout.completed"; properties: Record<string, never> }
  | { name: "email.verified"; properties: Record<string, never> }
  | { name: "org.created"; properties: { is_first_org: boolean; org_id: string } }
  | { name: "org.switched"; properties: { from_org_id: string | null; to_org_id: string } }
  | { name: "onboarding.step_viewed"; properties: { step: OnboardingStep; position: number } }
  | {
      name: "onboarding.step_completed";
      properties: { step: OnboardingStep; time_to_complete_ms?: number };
    }
  | { name: "onboarding.skipped"; properties: { last_completed_step: OnboardingStep | null } }

  // ── Account connection ──────────────────────────────────────────────
  | {
      name: "connect.drawer_opened";
      properties: { entry_point: "sidebar" | "onboarding" | "empty-state" | "accounts-page" };
    }
  | { name: "connect.platform_selected"; properties: { platform: Platform } }
  | {
      name: "connect.oauth_started";
      properties: { platform: Platform; scopes_requested: string[] };
    }
  | {
      name: "connect.oauth_returned";
      properties: {
        platform: Platform;
        outcome: "success" | "denied" | "error";
        error_code?: string;
      };
    }
  | {
      name: "account.connected";
      properties: {
        platform: Platform;
        account_type: "personal" | "org" | "page" | "business";
        scopes_granted: string[];
      };
    }
  | {
      name: "account.disconnected";
      properties: { platform: Platform; account_age_days?: number };
    }
  | {
      name: "account.token_refresh_failed";
      properties: { platform: Platform; error_code: string };
    }
  | {
      name: "pinterest.default_board_set";
      properties: { board_count: number };
    }

  // ── Publishing ──────────────────────────────────────────────────────
  | { name: "post_composer.opened"; properties: { entry_point: string } }
  | {
      name: "post.submitted";
      properties: {
        platforms: Platform[];
        has_media: boolean;
        media_count: number;
        scheduled: boolean;
      };
    }
  | {
      name: "post.preflight_failed";
      properties: {
        platforms: Platform[];
        rule: string;
        error_code: string;
      };
    }
  | {
      name: "post.published";
      properties: {
        platforms: Platform[];
        had_preflight_warning: boolean;
        latency_ms?: number;
      };
    }
  | {
      name: "post.rejected";
      properties: {
        platform: Platform;
        error_code: string;
        platform_response_summary?: string;
      };
    }
  | {
      name: "post.retry_clicked";
      properties: { original_error_code: string; platform: Platform };
    }
  | {
      name: "post.retry_succeeded";
      properties: { original_error_code: string; attempts: number };
    }
  | {
      name: "post_log.filtered";
      properties: {
        filter_field: "platform" | "status" | "error_code";
        filter_value: string;
      };
    }
  | { name: "post_detail.viewed"; properties: { status: PostStatus } }
  | {
      name: "post_detail.raw_response_expanded";
      properties: { platform: Platform; status: PostStatus };
    }

  // ── API keys & developer surface ────────────────────────────────────
  | {
      name: "api_key.created";
      properties: { environment: "live" | "test"; name_provided: boolean };
    }
  | {
      name: "api_key.revoked";
      properties: { key_age_days?: number };
    }
  | { name: "api_key.copied"; properties: { environment: "live" | "test" } }
  | { name: "docs.opened_from_dashboard"; properties: { from_section: string } }

  // ── Webhooks ────────────────────────────────────────────────────────
  | {
      name: "webhook.endpoint_created";
      properties: { event_count: number };
    }
  | {
      name: "webhook.endpoint_updated";
      properties: { field: "url" | "events" | "enabled" };
    }
  | {
      name: "webhook.endpoint_deleted";
      properties: { endpoint_age_days?: number };
    }
  | { name: "webhook.test_sent"; properties: { event_type: WebhookEventType } }
  | {
      name: "webhook.test_succeeded";
      properties: { event_type: WebhookEventType; latency_ms?: number };
    }
  | {
      name: "webhook.test_failed";
      properties: {
        event_type: WebhookEventType;
        status_code?: number;
        error_code?: string;
      };
    }

  // ── Org & settings ──────────────────────────────────────────────────
  | { name: "member.invited"; properties: { role: string } }
  | { name: "theme.changed"; properties: { from: string; to: string } }

  // ── Feature requests ────────────────────────────────────────────────
  // Surface area for v2 demand signals — every "I want this" click on a
  // coming-soon screen lands here with the feature identifier so we can
  // rank the backlog by actual votes instead of guesses.
  | {
      name: "feature.requested";
      properties: { feature: "analytics" | "queue" | "draft" | "bulk_csv" };
    };

export function track<T extends DashboardEvent>(event: T): void {
  if (typeof window === "undefined") return;
  if (!posthog.__loaded) return;
  posthog.capture(event.name, event.properties);
}
