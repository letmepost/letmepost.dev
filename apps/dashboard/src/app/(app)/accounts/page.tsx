"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Plus, Trash } from "@phosphor-icons/react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import type { Account } from "@/lib/accounts";
import { useActiveProfile } from "@/lib/profiles";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { ConnectAccountDrawer } from "@/components/app/connect-account-drawer";
import { FadeIn, StaggerList, StaggerItem } from "@/components/app/motion";
import { PinterestDefaultBoard } from "@/components/app/pinterest-default-board";
import { PLATFORM_BRANDS } from "@/components/app/platform-icons";
import { track, asAnalyticsPlatform } from "@/lib/analytics";

// Brand lookup keyed by platform id. Falls back to a neutral grey block
// if a future platform adds an account row before its brand entry lands.
const BRAND_BY_ID = Object.fromEntries(
  PLATFORM_BRANDS.map((b) => [b.id, b]),
) as Record<string, (typeof PLATFORM_BRANDS)[number]>;
const FALLBACK_COLOR = "#737373";

export default function AccountsListPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeProfile, activeProfileId, isLoading: profilesLoading } =
    useActiveProfile();
  const [pendingDisconnect, setPendingDisconnect] = useState<Account | null>(
    null,
  );
  const [connectOpen, setConnectOpen] = useState(false);

  // The API's OAuth callback (GET /v1/accounts/oauth/:platform/callback)
  // redirects here with `?connected=<platform>` on success or
  // `?connect_error=<reason>&platform=<p>` on failure. Surface a toast
  // and clean the query so a refresh doesn't re-fire it. Invalidate by the
  // top-level "accounts" prefix so every profile-scoped variant refetches —
  // we don't know which profile the OAuth state row carried.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("connect_error");
    const platform = searchParams.get("platform");
    if (!connected && !error) return;
    if (connected) {
      const p = asAnalyticsPlatform(connected);
      if (p) {
        track({
          name: "connect.oauth_returned",
          properties: { platform: p, outcome: "success" },
        });
      }
      toast.success(`Connected ${connected}.`);
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    } else if (error) {
      const rule = searchParams.get("connect_rule");
      const message = searchParams.get("connect_message");
      const remediation = searchParams.get("connect_remediation");
      const p = asAnalyticsPlatform(platform);
      if (p) {
        track({
          name: "connect.oauth_returned",
          properties: {
            platform: p,
            outcome: error === "user_denied" ? "denied" : "error",
            error_code: error,
            ...(rule ? { error_rule: rule } : {}),
          },
        });
      }
      // When the API forwarded a real message + remediation, render it as a
      // persistent toast (duration: Infinity) so the user has time to read
      // multi-step instructions like "open IG app → Settings → switch account
      // type." The fallback path keeps the old generic "X connect failed: Y"
      // shape so codes without a paired rule still surface something.
      if (message) {
        toast.error(message, {
          description: remediation ?? undefined,
          duration: Infinity,
          closeButton: true,
        });
      } else {
        toast.error(
          platform
            ? `${platform} connect failed: ${error.replaceAll("_", " ")}`
            : `Connect failed: ${error.replaceAll("_", " ")}`,
        );
      }
    }
    // Strip the params without scrolling.
    router.replace("/accounts", { scroll: false });
  }, [searchParams, router, queryClient]);

  // Don't fire the list query until we know which profile to scope to —
  // otherwise the first request goes out unfiltered, caches the org-wide
  // list under `["accounts", null]`, and a subsequent profile pick has to
  // wait for the refetch to overwrite the wrong data on screen.
  const query = useQuery({
    queryKey: queryKeys.accounts.list(activeProfileId),
    queryFn: () => {
      const qs = activeProfileId
        ? `?profileId=${encodeURIComponent(activeProfileId)}`
        : "";
      return apiFetch<{ data: Account[] }>(`/v1/accounts${qs}`).then(
        (r) => r.data ?? [],
      );
    },
    enabled: !profilesLoading,
  });
  const accounts = query.data ?? null;
  const error = query.error
    ? query.error instanceof ApiRequestError
      ? query.error.payload.message
      : query.error instanceof Error
        ? query.error.message
        : "Failed to load."
    : null;

  const deleteMutation = useMutation({
    mutationFn: (acc: Account) =>
      apiFetch<{ id: string }>(`/v1/accounts/${acc.id}`, { method: "DELETE" }).then(
        (res) => ({ ...res, _platform: acc.platform }),
      ),
    onSuccess: (res) => {
      const p = asAnalyticsPlatform(res._platform);
      if (p) {
        track({
          name: "account.disconnected",
          properties: { platform: p },
        });
      }
      toast.success("Account disconnected.");
      // Prefix match — the list query is keyed by `["accounts", profileId]`.
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Delete failed.",
      );
    },
  });

  return (
    <div className="space-y-6">
      <FadeIn className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Accounts</h1>
          <p className="text-xs text-muted-foreground">
            {activeProfile
              ? `Connected platform accounts in ${activeProfile.name}. Tokens encrypted at rest.`
              : "Connected social platform accounts. Tokens are encrypted at rest."}
          </p>
        </div>
        <Button
          onClick={() => {
            track({
              name: "connect.drawer_opened",
              properties: { entry_point: "accounts-page" },
            });
            setConnectOpen(true);
          }}
        >
          <Plus className="size-4" />
          Connect account
        </Button>
      </FadeIn>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load accounts</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : accounts === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : accounts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {activeProfile
                ? `No accounts in ${activeProfile.name}`
                : "No accounts yet"}
            </CardTitle>
            <CardDescription>
              {activeProfile
                ? `${activeProfile.name} doesn't have a social account wired up yet. Connect one and you can start publishing under this profile — accounts are scoped per profile.`
                : "Connect your first platform — Bluesky takes about thirty seconds with an app password, the others run through OAuth. We hold the tokens, encrypted, and refresh on the right schedule."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => {
                track({
                  name: "connect.drawer_opened",
                  properties: { entry_point: "empty-state" },
                });
                setConnectOpen(true);
              }}
            >
              Connect account
            </Button>
          </CardContent>
        </Card>
      ) : (
        <StaggerList className="grid gap-4 md:grid-cols-2">
          {accounts.map((acc) => {
            const brand = BRAND_BY_ID[acc.platform];
            const accentColor = brand?.color ?? FALLBACK_COLOR;
            const Icon = brand?.Icon;
            const label = brand?.label ?? acc.platform;
            return (
              <StaggerItem key={acc.id} className="h-full">
                <Card
                  className="flex flex-col h-full border-l-4"
                  style={{ borderLeftColor: accentColor }}
                >
                  <CardHeader>
                    <div
                      className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider"
                      style={{ color: accentColor }}
                    >
                      {Icon ? <Icon className="size-3.5" /> : null}
                      <span>{label}</span>
                    </div>
                    <CardTitle className="mt-2">
                      {acc.displayName ?? acc.handle ?? acc.id}
                    </CardTitle>
                    {acc.handle ? (
                      <CardDescription>@{acc.handle}</CardDescription>
                    ) : null}
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(acc.id);
                          toast.success("Account id copied.");
                        } catch {
                          toast.error("Clipboard access denied.");
                        }
                      }}
                      className="mt-2 group inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground hover:text-foreground transition-colors max-w-full"
                      title="Click to copy"
                    >
                      <span className="truncate">{acc.id}</span>
                      <Copy
                        className="size-3 shrink-0 opacity-50 group-hover:opacity-100 transition-opacity"
                        weight="regular"
                      />
                    </button>
                  </CardHeader>
                  <CardContent className="flex flex-col flex-1 gap-3">
                    {acc.platform === "pinterest" ? (
                      <PinterestDefaultBoard accountId={acc.id} />
                    ) : null}
                    <div className="mt-auto flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        Token refresh managed
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDisconnect(acc)}
                        >
                          <Trash className="size-4" />
                          Disconnect
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </StaggerItem>
            );
          })}
        </StaggerList>
      )}

      <ConnectAccountDrawer
        open={connectOpen}
        onOpenChange={setConnectOpen}
      />

      <ConfirmDialog
        open={pendingDisconnect !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDisconnect(null);
        }}
        title="Disconnect account?"
        description={
          pendingDisconnect ? (
            <>
              This removes{" "}
              <span className="font-medium text-foreground">
                {pendingDisconnect.displayName ??
                  pendingDisconnect.handle ??
                  pendingDisconnect.id}
              </span>{" "}
              from your organization. Posting will stop until you reconnect.
            </>
          ) : null
        }
        confirmLabel="Disconnect"
        variant="destructive"
        onConfirm={async () => {
          if (pendingDisconnect)
            await deleteMutation.mutateAsync(pendingDisconnect);
        }}
      />
    </div>
  );
}

