"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { apiFetch, ApiRequestError } from "@/lib/api";
import {
  CONNECTABLE_PLATFORMS,
  type ConnectablePlatform,
  type ConnectDescriptor,
  type ConnectResponse,
} from "@/lib/accounts";
import { useActiveProfile } from "@/lib/profiles";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const LABELS: Record<ConnectablePlatform, string> = {
  bluesky: "Bluesky",
  facebook: "Facebook (+ Instagram)",
  // Instagram is an option for completeness even though `/connect/instagram`
  // is not actually wired — connecting Facebook fans out to IG Business
  // accounts linked to each Page. Surfaced as a label so users searching
  // for "Instagram" don't think we don't support it.
  instagram: "Instagram",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  threads: "Threads",
  twitter: "Twitter / X",
};

/**
 * Connect-Account flow (MVP):
 *
 *   1. Pick a platform from the dropdown.
 *   2. `POST /v1/accounts/connect/:platform` returns a ConnectDescriptor.
 *   3. descriptor.kind === "oauth"        → render a single "Connect with X"
 *                                           button that opens authorizationUrl.
 *   3. descriptor.kind === "credentials"  → render a dynamic form from
 *                                           descriptor.fields[] and POST to
 *                                           `/complete` on submit.
 *
 * Everything about each platform's auth mode is the API's problem. The
 * dashboard never hardcodes "bluesky uses app passwords" — the descriptor
 * tells us at runtime. That's the whole point.
 */
export default function NewAccountPage() {
  const router = useRouter();
  const { profiles, activeProfile } = useActiveProfile();
  const [profileId, setProfileId] = useState<string | null>(null);
  const effectiveProfileId = profileId ?? activeProfile?.id ?? null;
  const [platform, setPlatform] = useState<ConnectablePlatform | "">("");
  const [descriptor, setDescriptor] = useState<ConnectDescriptor | null>(null);
  const [descriptorPlatform, setDescriptorPlatform] = useState<string | null>(
    null,
  );
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [descriptorError, setDescriptorError] = useState<string | null>(null);

  async function handlePlatformChange(next: ConnectablePlatform) {
    setPlatform(next);
    setDescriptor(null);
    setDescriptorPlatform(null);
    setFormValues({});
    setDescriptorError(null);
    setSubmitting(true);
    try {
      // returnTo lands the user back on the dashboard origin (home) after
      // the OAuth callback instead of the static /accounts page. The API
      // validates this against TRUSTED_ORIGINS + DASHBOARD_URL.
      const returnTo =
        typeof window !== "undefined"
          ? `${window.location.origin}/`
          : undefined;
      const res = await apiFetch<ConnectResponse>(
        `/v1/accounts/connect/${next}`,
        {
          method: "POST",
          body: {
            ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
            ...(returnTo ? { returnTo } : {}),
          },
        },
      );
      setDescriptor(res.descriptor);
      setDescriptorPlatform(res.platform ?? next);
      if (res.descriptor.kind === "credentials") {
        const seed: Record<string, string> = {};
        for (const field of res.descriptor.fields) seed[field.name] = "";
        setFormValues(seed);
      }
    } catch (err) {
      setDescriptorError(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Could not start connect flow.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCredentialsSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!platform || !descriptor || descriptor.kind !== "credentials") return;
    setSubmitting(true);
    try {
      // Drop empty strings from optional fields — see onboarding-connect.tsx
      // for the rationale (zod `.url().optional()` rejects "" before optional
      // can apply).
      const trimmed: Record<string, string> = {};
      for (const [k, v] of Object.entries(formValues)) {
        if (typeof v === "string" && v.trim() === "") continue;
        trimmed[k] = v;
      }
      await apiFetch(`/v1/accounts/connect/${platform}/complete`, {
        method: "POST",
        body: {
          ...trimmed,
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
        },
      });
      toast.success("Account connected.");
      router.push("/accounts");
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Connect failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-lg font-semibold">Connect account</h1>
        <p className="text-xs text-muted-foreground">
          Choose a platform. We'll handle OAuth redirects, app passwords, and
          any other auth flow it needs.
        </p>
      </div>

      {profiles.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Where the account lands inside this org. Defaults to your active
              profile from the sidebar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="connect-profile">Profile</Label>
              <Select
                value={effectiveProfileId ?? ""}
                onValueChange={(v) => setProfileId(v)}
              >
                <SelectTrigger id="connect-profile" className="w-full">
                  <SelectValue placeholder="Select a profile…" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Platform</CardTitle>
          <CardDescription>
            Pick where you want to post. More platforms are added as the API
            grows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="platform">Platform</Label>
            <Select
              value={platform}
              onValueChange={(v) =>
                handlePlatformChange(v as ConnectablePlatform)
              }
            >
              <SelectTrigger id="platform" className="w-full">
                <SelectValue placeholder="Select a platform…" />
              </SelectTrigger>
              <SelectContent>
                {CONNECTABLE_PLATFORMS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {descriptorError ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t start connect flow</CardTitle>
            <CardDescription>{descriptorError}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {descriptor && descriptorPlatform ? (
        descriptor.kind === "oauth" ? (
          <Card>
            <CardHeader>
              <CardTitle>
                Connect with {LABELS[descriptorPlatform as ConnectablePlatform] ??
                  descriptorPlatform}
              </CardTitle>
              <CardDescription>
                You'll be redirected to authorize access. The callback comes
                back to this app and finishes the connection automatically.
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button asChild>
                <a href={descriptor.authorizationUrl}>
                  Connect with{" "}
                  {LABELS[descriptorPlatform as ConnectablePlatform] ??
                    descriptorPlatform}
                </a>
              </Button>
            </CardFooter>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>
                Connect{" "}
                {LABELS[descriptorPlatform as ConnectablePlatform] ??
                  descriptorPlatform}
              </CardTitle>
              <CardDescription>
                Credentials-based auth. Submit the fields below to complete
                the connection.
              </CardDescription>
            </CardHeader>
            <form onSubmit={handleCredentialsSubmit}>
              <CardContent className="space-y-4">
                {descriptor.fields.map((field) => (
                  <div key={field.name} className="space-y-2">
                    <Label htmlFor={field.name}>{field.label}</Label>
                    <Input
                      id={field.name}
                      type={field.type ?? "text"}
                      placeholder={field.placeholder}
                      required={field.required ?? true}
                      value={formValues[field.name] ?? ""}
                      onChange={(e) =>
                        setFormValues((prev) => ({
                          ...prev,
                          [field.name]: e.target.value,
                        }))
                      }
                    />
                    {field.description ? (
                      <p className="text-xs text-muted-foreground">
                        {field.description}
                      </p>
                    ) : null}
                  </div>
                ))}
              </CardContent>
              <CardFooter className="gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Connecting…" : "Connect"}
                </Button>
                <Button variant="ghost" asChild>
                  <Link href="/accounts">Cancel</Link>
                </Button>
              </CardFooter>
            </form>
          </Card>
        )
      ) : null}
    </div>
  );
}
