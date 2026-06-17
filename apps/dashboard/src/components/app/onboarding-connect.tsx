"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft } from "@phosphor-icons/react";
import { toast } from "sonner";
import { apiFetch, ApiRequestError } from "@/lib/api";
import {
  PLATFORM_STATE,
  type ConnectablePlatform,
  type ConnectDescriptor,
  type ConnectResponse,
  type PlatformState,
} from "@/lib/accounts";
import { useActiveProfile } from "@/lib/profiles";
import { PLATFORM_BRANDS } from "@/components/app/platform-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Inline connect flow used inside the onboarding accordion. Replaces the
 * detour through /accounts/new for first-time users.
 *
 *   - OAuth platforms: clicking the icon hits POST /v1/accounts/connect/:p,
 *     reads back an OAuth descriptor, and full-page-redirects to the auth
 *     URL. (Full page navigation is intentional — the OAuth callback lands
 *     on the API origin and bounces back; popup-based flows are a maintenance
 *     pit we're not paying for in MVP.)
 *   - Credentials platforms (Bluesky): swaps the icon grid for a dynamic
 *     form rendered from descriptor.fields[]. On submit POSTs `/complete` and
 *     fires `onConnected()` — the parent refreshes counts, the checklist's
 *     auto-advance hook moves the open row to the next incomplete step.
 */
export function OnboardingConnect({
  onConnected,
  size = "default",
}: {
  onConnected: () => void;
  /**
   * Visual scale for the platform grid. `default` is the onboarding
   * accordion variant (40px icons, 2×4 tight grid). `large` is the
   * standalone /accounts/new variant (64px icons, taller tiles).
   */
  size?: "default" | "large";
}) {
  const { profiles, activeProfile } = useActiveProfile();
  const [profileId, setProfileId] = useState<string | null>(null);
  const effectiveProfileId = profileId ?? activeProfile?.id ?? null;

  const [picked, setPicked] = useState<ConnectablePlatform | null>(null);
  const [descriptor, setDescriptor] = useState<ConnectDescriptor | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setPicked(null);
    setDescriptor(null);
    setFormValues({});
    setError(null);
  }

  async function handlePick(platform: ConnectablePlatform) {
    if (busy) return;
    setPicked(platform);
    setBusy(true);
    setError(null);
    track({
      name: "connect.platform_selected",
      properties: { platform },
    });
    try {
      // Onboarding connections should return the user to the dashboard
      // home so they see the post-connect success state, not the static
      // /accounts list page.
      const returnTo =
        typeof window !== "undefined"
          ? `${window.location.origin}/`
          : undefined;
      const res = await apiFetch<ConnectResponse>(
        `/v1/accounts/connect/${platform}`,
        {
          method: "POST",
          // Pass profileId so the OAuth state row (when wired) carries it
          // through the redirect; for credentials flows, /complete reads it
          // from its own body below.
          body: {
            ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
            ...(returnTo ? { returnTo } : {}),
          },
        },
      );
      if (res.descriptor.kind === "oauth") {
        track({
          name: "connect.oauth_started",
          properties: { platform, scopes_requested: [] },
        });
        // Full-page redirect — the OAuth callback finishes server-side.
        window.location.href = res.descriptor.authorizationUrl;
        return;
      }
      const seed: Record<string, string> = {};
      for (const f of res.descriptor.fields) seed[f.name] = "";
      setFormValues(seed);
      setDescriptor(res.descriptor);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Couldn't start the connect flow.",
      );
      setPicked(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked || !descriptor || descriptor.kind !== "credentials") return;
    setBusy(true);
    try {
      // Strip empty strings from optional fields — zod validators like
      // `.url()` on an optional field still reject "" before `.optional()`
      // can let it through. Sending `undefined` (omitting the key) is the
      // safe default; required fields fail their own min(1) check anyway.
      const trimmed: Record<string, string> = {};
      for (const [k, v] of Object.entries(formValues)) {
        if (typeof v === "string" && v.trim() === "") continue;
        trimmed[k] = v;
      }
      await apiFetch(`/v1/accounts/connect/${picked}/complete`, {
        method: "POST",
        body: {
          ...trimmed,
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
        },
      });
      track({
        name: "account.connected",
        properties: {
          platform: picked,
          account_type: "personal",
          scopes_granted: [],
        },
      });
      toast.success("Account connected.");
      reset();
      onConnected();
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Connect failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const showCredentialsForm =
    descriptor?.kind === "credentials" && picked !== null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Pick a platform. Bluesky uses an app password. The others go through
        OAuth. Tokens are encrypted at rest with per-row data-keys.
      </p>

      {profiles.length > 1 ? (
        <div className="flex items-center gap-3">
          <Label htmlFor="onb-profile" className="text-xs text-muted-foreground shrink-0">
            Connect into
          </Label>
          <Select
            value={effectiveProfileId ?? ""}
            onValueChange={(v) => setProfileId(v)}
          >
            <SelectTrigger
              id="onb-profile"
              className="h-8 w-[200px] text-xs"
            >
              <SelectValue placeholder="Select profile" />
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
      ) : null}

      <AnimatePresence mode="wait" initial={false}>
        {showCredentialsForm ? (
          <motion.form
            key="creds"
            onSubmit={handleSubmit}
            initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{
              opacity: 0,
              y: -6,
              filter: "blur(6px)",
              transition: { duration: 0.18, ease: EASE_OUT },
            }}
            transition={{ duration: 0.28, ease: EASE_OUT }}
            className="space-y-4 rounded-md ring-1 ring-foreground/10 bg-card p-4"
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">
                Connect{" "}
                {PLATFORM_BRANDS.find((b) => b.id === picked)?.label ?? picked}
              </div>
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <ArrowLeft className="size-3" />
                back
              </button>
            </div>
            {descriptor && descriptor.kind === "credentials"
              ? descriptor.fields.map((field) => (
                  <div key={field.name} className="space-y-1.5">
                    <Label htmlFor={`onb-${field.name}`}>{field.label}</Label>
                    <Input
                      id={`onb-${field.name}`}
                      type={field.type ?? "text"}
                      placeholder={field.placeholder}
                      required={field.required ?? true}
                      className="h-9"
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
                ))
              : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={reset}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </motion.form>
        ) : (
          <motion.div
            key="grid"
            initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{
              opacity: 0,
              y: -6,
              filter: "blur(6px)",
              transition: { duration: 0.18, ease: EASE_OUT },
            }}
            transition={{ duration: 0.28, ease: EASE_OUT }}
            className={cn(
              "grid gap-3",
              size === "large"
                ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
                : "grid-cols-2 sm:grid-cols-4 gap-2",
            )}
          >
            {PLATFORM_BRANDS.map((b) => {
              const state: PlatformState = PLATFORM_STATE[b.id] ?? "pending";
              const pending = state === "pending";
              const active = picked === b.id && busy;
              const dim = busy && picked !== b.id;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => !pending && handlePick(b.id)}
                  disabled={busy || pending}
                  aria-busy={active}
                  aria-disabled={pending}
                  title={
                    pending
                      ? `${b.label} is pending platform approval. Coming soon.`
                      : undefined
                  }
                  className={cn(
                    "group relative flex flex-col items-center rounded-md ring-1 ring-foreground/10 bg-card transition-[box-shadow,opacity] duration-200",
                    size === "large" ? "gap-3 px-4 py-8" : "gap-2 px-3 py-5",
                    !busy && !pending && "hover:ring-foreground/40 hover:bg-muted/40",
                    active && "ring-primary",
                    dim && "opacity-40 pointer-events-none",
                    pending && "opacity-50 cursor-not-allowed",
                  )}
                >
                  {state === "trial" ? (
                    <span
                      className="absolute top-1 right-1 text-[9px] uppercase tracking-wider px-1 py-px ring-1 ring-foreground/20 text-muted-foreground"
                      aria-label="Trial, limited access"
                    >
                      trial
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "transition-[filter,opacity] duration-200",
                      size === "large" ? "size-16" : "size-10",
                      "grayscale opacity-55",
                      !pending && "group-hover:grayscale-0 group-hover:opacity-100",
                      active && "grayscale-0 opacity-100",
                      pending && "opacity-30",
                    )}
                    style={{ color: b.color }}
                  >
                    <b.Icon className="size-full" />
                  </span>
                  <span
                    className={cn(
                      "font-medium text-muted-foreground transition-colors",
                      size === "large" ? "text-sm" : "text-xs",
                      !pending && "group-hover:text-foreground",
                      active && "text-foreground",
                    )}
                  >
                    {pending ? "Coming soon" : active ? "Opening…" : b.label}
                  </span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {error ? (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-xs text-destructive"
        >
          {error}
        </motion.p>
      ) : null}
    </div>
  );
}
