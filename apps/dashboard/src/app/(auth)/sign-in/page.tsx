"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { API_URL } from "@/lib/env";
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
 * When the OAuth provider redirects the user here for sign-in, it appends the
 * full signed authorize-query (response_type, client_id, scope, state,
 * code_challenge, exp, iat, sig, …). After successful sign-in we have to send
 * the user back to /api/auth/oauth2/authorize WITH those exact params so the
 * authorize handler can verify the signature and continue the flow. Anything
 * else (a bare router.push("/")) drops the OAuth dance on the floor.
 *
 * The presence of `response_type=code` is our signal that we're inside an OAuth
 * loop. If absent, this is a plain dashboard sign-in and we fall back to "/".
 */
function buildPostSignInRedirect(search: URLSearchParams): string {
  if (!search.get("response_type")) return "/";
  return `${API_URL}/api/auth/oauth2/authorize?${search.toString()}`;
}

export default function SignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const { error } = await authClient.signIn.email({ email, password });
      if (error) {
        toast.error(error.message ?? "Sign-in failed.");
        return;
      }
      track({ name: "signin.completed", properties: { provider: "email" } });
      const target = buildPostSignInRedirect(
        new URLSearchParams(searchParams?.toString() ?? ""),
      );
      // Full-page nav (not router.push) so the browser actually leaves the
      // dashboard origin and the API receives the request with the new
      // session cookie attached.
      window.location.href = target;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Sign-in request failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <Card className="py-6 gap-6">
        <CardHeader className="gap-1.5 px-6">
          <CardTitle className="text-base font-semibold">Sign in</CardTitle>
          <CardDescription>
            One inbox. One operator. Pick up where you left off.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 space-y-4">
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
              autoComplete="current-password"
              required
              className="h-9 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Don&apos;t have an account?{" "}
            <Link className="underline underline-offset-2" href="/sign-up">
              Sign up
            </Link>
          </p>
        </CardFooter>
      </Card>
    </form>
  );
}
