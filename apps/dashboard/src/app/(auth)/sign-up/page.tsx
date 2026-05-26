"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/analytics";
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

/**
 * Sign-up is a two-step flow:
 *   1. Create the user account (better-auth email/password).
 *   2. Create an org and set it as active — every authenticated route in the
 *      API requires `session.organizationId` to be populated.
 *
 * We run both steps in one submit so the user never lands on an
 * "orgless" session state.
 */
export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
      const { error: signUpError } = await authClient.signUp.email({
        name,
        email,
        password,
      });
      if (signUpError) {
        toast.error(signUpError.message ?? "Sign-up failed.");
        return;
      }
      track({ name: "signup.completed", properties: { provider: "email" } });

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
    track({
      name: "signup.started",
      properties: {
        provider: "email",
        referrer: typeof document !== "undefined" ? document.referrer : undefined,
      },
    });
  }

  return (
    <form onSubmit={onSubmit} onFocus={onFirstFocus}>
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
        </CardContent>
        <CardFooter className="px-6 py-4 flex-col items-stretch gap-3">
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Create account"}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Already have an account?{" "}
            <Link className="underline underline-offset-2" href="/sign-in">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </Card>
    </form>
  );
}
