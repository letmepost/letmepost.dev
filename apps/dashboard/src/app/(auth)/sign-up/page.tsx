"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/analytics";
import { readAttribution } from "@/lib/attribution";
import {
  EmailIcon,
  GitHubIcon,
  GoogleIcon,
} from "@/components/auth/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Email-path attribution is passed inline via better-auth additionalFields.
// OAuth path can't piggyback fields on the provider round-trip, so we set
// this flag before redirect; PostHogProvider reads it on session-return
// and PATCHes /v1/auth/attribution with the stashed localStorage values.
const PENDING_PATCH_KEY = "lmp_pending_attribution_patch";

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [socialBusy, setSocialBusy] = useState<"google" | "github" | null>(null);
  const [showEmailForm, setShowEmailForm] = useState(false);

  function deriveSlug(input: string): string {
    return (
      input
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || `org-${Math.random().toString(36).slice(2, 8)}`
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const attribution = readAttribution();
      const { error: signUpError } = await authClient.signUp.email({
        name,
        email,
        password,
        ...attribution,
      });
      if (signUpError) {
        toast.error(signUpError.message ?? "Sign-up failed.");
        return;
      }
      track({ name: "signup.completed", properties: { provider: "email" } });

      // When the API has `requireEmailVerification: true` (production),
      // signUp.email succeeds but no session lands until the user clicks
      // the verification link. organization.create would 401 in that
      // window. Probe for a session first; if none, stash the requested
      // org name and route to the verify-email screen so the user gets a
      // clear "check your inbox" instead of a confusing 401 toast.
      const sessionProbe = await authClient.getSession();
      if (!sessionProbe.data?.session) {
        if (typeof window !== "undefined") {
          // Stash the requested org name only. The email is already on the
          // /verify-email URL for display; the session carries it on the
          // way back, so we don't need to round-trip it through storage.
          window.localStorage.setItem(
            "letmepost:pending-org",
            JSON.stringify({ name: orgName }),
          );
        }
        router.push(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      }

      const slug = deriveSlug(orgName);
      const { data: org, error: orgError } =
        await authClient.organization.create({ name: orgName, slug });
      if (orgError || !org) {
        // Account exists but org didn't land — kick to /onboarding rather
        // than leaving the user stuck on sign-up with a half-state session.
        toast.error(orgError?.message ?? "Finish setting up your organization.");
        router.push("/onboarding");
        return;
      }
      track({
        name: "org.created",
        properties: { is_first_org: true, org_id: org.id },
      });

      try {
        await authClient.organization.setActive({ organizationId: org.id });
      } catch {
        toast.error("Created your org but couldn't activate it. Pick it now.");
        router.push("/onboarding");
        return;
      }
      toast.success("Welcome to letmepost.");
      router.push("/");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Sign-up request failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // `signup.started` fires on the first interaction with the form
  // (focus on any field). One-shot via a ref-style flag so subsequent
  // focuses don't multiply the count. Kept inline because it's the
  // only piece of telemetry that benefits from the form-focus signal.
  function onFirstFocus(e: React.FocusEvent<HTMLFormElement>) {
    if (e.currentTarget.dataset.tracked === "1") return;
    e.currentTarget.dataset.tracked = "1";
    const attribution = readAttribution();
    track({
      name: "signup.started",
      properties: {
        provider: "email",
        referrer: typeof document !== "undefined" ? document.referrer : undefined,
        signup_source: attribution.signupSource,
        utm_source: attribution.signupUtmSource,
        utm_medium: attribution.signupUtmMedium,
        utm_campaign: attribution.signupUtmCampaign,
      },
    });
  }

  async function onSocial(provider: "google" | "github") {
    if (socialBusy) return;
    setSocialBusy(provider);
    try {
      // Mark this browser as awaiting an attribution PATCH. The flag is
      // read by PostHogProvider once the OAuth callback returns a session;
      // it then ships the stashed `lmp_attribution` to the API and clears
      // both keys. Safe to write before the redirect since localStorage
      // survives the round-trip.
      try {
        window.localStorage.setItem(PENDING_PATCH_KEY, "1");
      } catch {
        // private mode / disabled storage — we'll just lose attribution
        // for this OAuth signup, which is acceptable.
      }
      track({
        name: "signup.started",
        properties: { provider },
      });
      // Absolute URL — a relative path resolves against the API baseURL.
      const { error } = await authClient.signIn.social({
        provider,
        callbackURL: `${window.location.origin}/`,
      });
      if (error) {
        toast.error(error.message ?? `${provider} sign-in failed.`);
        setSocialBusy(null);
      }
      // On success better-auth handles the full-page redirect to the
      // provider; nothing else to do here.
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `${provider} sign-in failed.`,
      );
      setSocialBusy(null);
    }
  }

  const anyBusy = submitting || socialBusy !== null;

  return (
    <Card className="py-6 gap-6">
      <CardHeader className="gap-1.5 px-6">
        <CardTitle className="text-base font-semibold">
          Send your first post in ninety seconds.
        </CardTitle>
        <CardDescription>
          Free for 50 posts a month, no card. You + your org now;
          invite teammates whenever.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 space-y-4">
        {/* Primary path: GitHub. Full-width, default variant, the only
            button at this tier — it carries the "this is a tool for
            builders" signal even before the user reads the copy. */}
        <Button
          type="button"
          size="lg"
          className="w-full gap-2"
          onClick={() => onSocial("github")}
          disabled={anyBusy}
        >
          <GitHubIcon size={18} />
          {socialBusy === "github" ? "Connecting…" : "Continue with GitHub"}
        </Button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        {/* Secondary tier: Google + Email side-by-side, both outline so
            the GitHub button retains primacy. Email is a disclosure
            toggle — clicking it expands the form below without leaving
            the page. */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-9 gap-2"
            onClick={() => onSocial("google")}
            disabled={anyBusy}
          >
            <GoogleIcon size={16} />
            {socialBusy === "google" ? "Connecting…" : "Google"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-9 gap-2"
            onClick={() => setShowEmailForm((v) => !v)}
            disabled={anyBusy}
            aria-expanded={showEmailForm}
            aria-controls="email-signup-form"
          >
            <EmailIcon size={16} />
            {showEmailForm ? "Hide email" : "Email"}
          </Button>
        </div>

        {showEmailForm && (
          <form
            id="email-signup-form"
            onSubmit={onSubmit}
            onFocus={onFirstFocus}
            className="space-y-4"
          >
          <div className="space-y-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input
              id="name"
              required
              className="h-9 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              className="h-9 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              className="h-9 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="orgName">Organization name</Label>
            <Input
              id="orgName"
              required
              placeholder="Acme Robotics"
              className="h-9 text-sm"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
          </div>
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={anyBusy}
            >
              {submitting ? "Creating…" : "Create account"}
            </Button>
          </form>
        )}
      </CardContent>
      <CardFooter className="px-6 py-4 flex-col items-stretch gap-3">
        <p className="text-xs text-muted-foreground text-center">
          Already have an account?{" "}
          <Link className="underline underline-offset-2" href="/sign-in">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
