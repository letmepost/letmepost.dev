"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { OnboardingConnect } from "@/components/app/onboarding-connect";
import type { ConnectablePlatform } from "@/lib/accounts";

/**
 * Right-side drawer wrapper around `OnboardingConnect`. Same descriptor-
 * driven flow as the home accordion / `/accounts/new`, but the accounts
 * list stays visible underneath — Linear / Stripe pattern.
 *
 * On successful credential connect we invalidate the accounts list and
 * close. OAuth completes via full-page redirect, so `onConnected` won't
 * fire in that path; the user lands back on /accounts after the callback
 * with the new account already in the list.
 */
export function ConnectAccountDrawer({
  open,
  onOpenChange,
  platform,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set by Reconnect: skips the picker and goes straight to this platform. */
  platform?: ConnectablePlatform;
}) {
  const queryClient = useQueryClient();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md flex flex-col gap-0 overflow-y-auto"
      >
        <SheetHeader className="border-b">
          <SheetTitle className="text-base">
            {platform ? `Reconnect ${platform}` : "Connect account"}
          </SheetTitle>
          <SheetDescription>
            We&apos;ll handle the OAuth redirect, app password, or whatever
            else the platform requires. Tokens land encrypted at rest with
            per-row data-keys.
          </SheetDescription>
        </SheetHeader>
        <div className="p-4">
          <OnboardingConnect
            {...(platform ? { initialPlatform: platform } : {})}
            onConnected={() => {
              // Top-level prefix invalidation matches every profile-scoped
              // variant (`["accounts", profileId]`). The newly-connected
              // account may belong to a non-active profile if the user
              // explicitly picked one in the form, so we don't risk being
              // too narrow.
              queryClient.invalidateQueries({ queryKey: ["accounts"] });
              onOpenChange(false);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
