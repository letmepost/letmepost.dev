"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Check } from "@phosphor-icons/react";
import { ApiRequestError } from "@/lib/api";
import {
  TIERS,
  compareTiers,
  useCheckout,
  useSubscription,
  type BillingTier,
} from "@/lib/billing";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { FadeIn } from "@/components/app/motion";
import { cn } from "@/lib/utils";

type DisplayTier = Extract<BillingTier, "free" | "pro" | "business">;

const DISPLAY_TIERS: DisplayTier[] = ["free", "pro", "business"];

export default function UpgradePage() {
  const subQuery = useSubscription();
  const sub = subQuery.data;
  const checkout = useCheckout();
  const [pendingDowngrade, setPendingDowngrade] = useState<
    "pro" | "business" | null
  >(null);

  if (sub?.tier === "self_host") {
    return (
      <div className="space-y-6">
        <FadeIn>
          <h1 className="text-lg font-semibold">Billing</h1>
          <p className="text-xs text-muted-foreground">
            Billing is disabled on this instance.
          </p>
        </FadeIn>
      </div>
    );
  }

  async function goToCheckout(targetTier: "pro" | "business") {
    try {
      const { url } = await checkout.mutateAsync({ targetTier });
      // Full-page nav: Lemon Squeezy checkout is the same-tab handoff
      // pattern (PayPal-style return URL), so the browser carries the
      // post-purchase redirect back to /billing.
      window.location.href = url;
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Couldn't start checkout.",
      );
    }
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/billing">
              <ArrowLeft className="size-3.5" />
              Back to billing
            </Link>
          </Button>
        </div>
        <h1 className="text-lg font-semibold mt-2">Pick a tier.</h1>
        <p className="text-xs text-muted-foreground">
          Monthly post volume is the only metered thing. No per-profile
          tax, no per-seat tax, no overage surprises. Cancel any time.
        </p>
      </FadeIn>

      {subQuery.isLoading || !sub ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DISPLAY_TIERS.map((tierId) => (
            <TierCard
              key={tierId}
              tierId={tierId}
              currentTier={sub.tier}
              isPending={checkout.isPending}
              onUpgrade={() => {
                if (tierId === "free") return;
                goToCheckout(tierId);
              }}
              onDowngrade={() => {
                if (tierId === "free") return;
                setPendingDowngrade(tierId);
              }}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Need more volume, SSO, custom SLA, or DPA? Email us at{" "}
        <a
          className="underline"
          href="mailto:hello@letmepost.dev"
        >
          hello@letmepost.dev
        </a>
        .
      </p>

      <ConfirmDialog
        open={pendingDowngrade !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDowngrade(null);
        }}
        title={`Downgrade to ${pendingDowngrade ? TIERS[pendingDowngrade].name : ""}?`}
        description={
          <>
            You&apos;ll keep your current plan until the end of the billing
            period. Quotas adjust at the next renewal. We&apos;ll route you
            through Lemon Squeezy to confirm.
          </>
        }
        confirmLabel="Continue"
        onConfirm={async () => {
          if (pendingDowngrade) await goToCheckout(pendingDowngrade);
        }}
      />
    </div>
  );
}

function TierCard({
  tierId,
  currentTier,
  isPending,
  onUpgrade,
  onDowngrade,
}: {
  tierId: DisplayTier;
  currentTier: BillingTier;
  isPending: boolean;
  onUpgrade: () => void;
  onDowngrade: () => void;
}) {
  const tier = TIERS[tierId];
  const isCurrent = tierId === currentTier;
  const direction = compareTiers(tierId, currentTier);
  const highlight = tierId === "pro";

  return (
    <div
      className={cn(
        "flex flex-col p-5 bg-card ring-1",
        highlight
          ? "ring-foreground/30 bg-primary/5"
          : "ring-foreground/10",
      )}
    >
      <div className="flex items-center justify-between mb-2 gap-2">
        <div
          className={cn(
            "text-[10px] uppercase tracking-[0.1em]",
            highlight ? "text-primary" : "text-muted-foreground",
          )}
        >
          {tier.name}
        </div>
        {highlight ? (
          <div className="text-[10px] uppercase tracking-[0.08em] text-primary ring-1 ring-primary px-1.5 py-0.5">
            Recommended
          </div>
        ) : null}
      </div>
      <div className="flex items-baseline gap-1 mb-1">
        <span className="text-2xl font-extrabold tabular-nums">
          ${tier.price}
        </span>
        <span className="text-xs text-muted-foreground">/mo</span>
      </div>
      <p className="text-xs text-muted-foreground m-0 mb-3">{tier.tagline}</p>
      <ul className="list-none p-0 m-0 text-xs text-foreground/80 flex-1 space-y-1.5">
        {tier.features.map((f) => (
          <li key={f} className="flex gap-2 items-start">
            <Check
              className={cn(
                "size-3 shrink-0 mt-0.5",
                highlight ? "text-primary" : "text-muted-foreground",
              )}
              weight="bold"
            />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5">
        {isCurrent ? (
          <Button variant="outline" disabled className="w-full">
            Current plan
          </Button>
        ) : direction > 0 ? (
          <Button
            variant={highlight ? "default" : "outline"}
            className="w-full"
            onClick={onUpgrade}
            disabled={isPending}
          >
            {isPending ? "Redirecting…" : `Upgrade to ${tier.name}`}
          </Button>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            onClick={onDowngrade}
            disabled={isPending || tierId === "free"}
            title={
              tierId === "free"
                ? "Cancel your subscription from the billing page to drop to Free."
                : undefined
            }
          >
            {tierId === "free"
              ? "Cancel to downgrade"
              : `Downgrade to ${tier.name}`}
          </Button>
        )}
      </div>
    </div>
  );
}
