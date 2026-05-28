"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Envelope } from "@phosphor-icons/react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

/**
 * Landing screen after email-password signup when verification is required.
 * Tells the user to check their inbox and offers a re-send. better-auth
 * handles the verification link click and creates the session on its own;
 * after that the user lands on /onboarding which creates the org from the
 * name we stashed in localStorage during signup.
 */
export default function VerifyEmailPage() {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const [resending, setResending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Poll briefly so a user who verified in another tab lands on /onboarding
    // (which lands them on / once the org exists) without needing a manual
    // refresh. Stops after the session arrives.
    const interval = setInterval(async () => {
      try {
        const s = await authClient.getSession();
        if (s.data?.session) {
          clearInterval(interval);
          window.location.assign("/onboarding");
        }
      } catch {
        // Ignore — keep polling.
      }
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  async function resend() {
    if (!email) {
      toast.error("Missing email — return to sign-up.");
      return;
    }
    setResending(true);
    try {
      const res = await authClient.sendVerificationEmail({ email });
      if (res.error) {
        toast.error(res.error.message ?? "Couldn't resend.");
      } else {
        toast.success("Sent a new verification email.");
        setSent(true);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't resend.");
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="space-y-6 text-center">
      <div className="size-12 rounded-full bg-muted/60 grid place-items-center mx-auto">
        <Envelope className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Check your inbox</h1>
        <p className="text-sm text-muted-foreground">
          We sent a verification link to{" "}
          <span className="font-semibold text-foreground">{email || "your email"}</span>.
          Click it to finish setting up your account.
        </p>
        <p className="text-xs text-muted-foreground">
          We'll redirect you automatically once it's verified. You can close
          this tab and come back later if needed.
        </p>
      </div>
      <div className="flex items-center justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={resend}
          disabled={resending || sent}
        >
          {resending ? "Sending…" : sent ? "Sent" : "Resend email"}
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a href="/sign-in">Sign in instead</a>
        </Button>
      </div>
    </div>
  );
}
