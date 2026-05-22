"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  ArrowSquareOut,
  ArrowsClockwise,
  Download,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import { ApiRequestError } from "@/lib/api";
import {
  TIERS,
  formatDate,
  formatMoney,
  isUnlimitedQuota,
  useCancelSubscription,
  useInvoices,
  usePortal,
  useReactivateSubscription,
  useSubscription,
  useSyncBilling,
  useUsage,
  type Subscription,
  type Usage,
} from "@/lib/billing";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { FadeIn } from "@/components/app/motion";
import { cn } from "@/lib/utils";

export default function BillingPage() {
  const subQuery = useSubscription();
  const sub = subQuery.data;

  // Self-host instances render a calm informational state with zero CTAs.
  // The /billing route still resolves (we don't 404) so deep links from
  // docs or sidebar don't break — they just land on this short message.
  if (sub?.tier === "self_host") {
    return (
      <div className="space-y-6">
        <FadeIn>
          <h1 className="text-lg font-semibold">Billing</h1>
          <p className="text-xs text-muted-foreground">
            Billing is disabled on this instance.
          </p>
        </FadeIn>
        <Card>
          <CardHeader>
            <CardTitle>Self-hosted</CardTitle>
            <CardDescription>
              You're running letmepost under Apache 2.0. There's nothing to
              charge for and nothing to upgrade. If you'd rather offload
              operations to us, the hosted version is at{" "}
              <Link href="https://letmepost.dev" className="underline">
                letmepost.dev
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <h1 className="text-lg font-semibold">Billing</h1>
        <p className="text-xs text-muted-foreground">
          Your plan, monthly usage, and invoices. Payment methods live in the
          Lemon Squeezy portal.
        </p>
      </FadeIn>

      {subQuery.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : subQuery.error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load your subscription</CardTitle>
            <CardDescription>
              {subQuery.error instanceof ApiRequestError
                ? subQuery.error.payload.message
                : subQuery.error instanceof Error
                  ? subQuery.error.message
                  : "Try again in a moment."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : sub ? (
        <>
          <StatusBanner subscription={sub} />
          <CurrentPlanCard subscription={sub} />
          <UsageCard subscription={sub} />
          <InvoicesSection />
        </>
      ) : null}
    </div>
  );
}

// ───────────────────────── status banner ─────────────────────────

function StatusBanner({ subscription }: { subscription: Subscription }) {
  const portal = usePortal();
  const reactivate = useReactivateSubscription();

  async function openPortal() {
    try {
      const { url } = await portal.mutateAsync();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Couldn't open the billing portal.",
      );
    }
  }

  async function handleReactivate() {
    try {
      await reactivate.mutateAsync();
      toast.success("Subscription reactivated.");
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Couldn't reactivate.",
      );
    }
  }

  // Delinquent supersedes past_due. Once the dunning sequence has exhausted
  // its retries and the account is delinquent we want the loud red banner,
  // not the softer amber one — even if `status` is technically still
  // "past_due" in some race-condition window.
  if (subscription.delinquent) {
    return (
      <BannerShell tone="destructive">
        <div className="flex-1">
          <div className="font-medium">Account delinquent.</div>
          <p className="text-xs text-muted-foreground">
            Your account is in a delinquent state. Update your payment method
            to restore full quota.
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={openPortal}
          disabled={portal.isPending}
        >
          Update payment method
          <ArrowSquareOut className="size-3.5" />
        </Button>
      </BannerShell>
    );
  }

  if (subscription.status === "past_due") {
    return (
      <BannerShell tone="warning">
        <div className="flex-1">
          <div className="font-medium">We couldn&apos;t charge your card.</div>
          <p className="text-xs text-muted-foreground">
            Update it before {formatDate(subscription.currentPeriodEnd)} to
            avoid service reduction.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={openPortal}
          disabled={portal.isPending}
        >
          Update payment method
          <ArrowSquareOut className="size-3.5" />
        </Button>
      </BannerShell>
    );
  }

  if (subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd) {
    return (
      <BannerShell tone="muted">
        <div className="flex-1">
          <div className="font-medium">Subscription cancelled.</div>
          <p className="text-xs text-muted-foreground">
            Your plan will downgrade to Free on{" "}
            {formatDate(subscription.currentPeriodEnd)}. Reactivate to keep it.
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={handleReactivate}
          disabled={reactivate.isPending}
        >
          {reactivate.isPending ? "Reactivating…" : "Reactivate"}
        </Button>
      </BannerShell>
    );
  }

  if (subscription.grandfathered) {
    return (
      <BannerShell tone="info">
        <div className="flex-1">
          <div className="font-medium">Alpha grace period.</div>
          <p className="text-xs text-muted-foreground">
            You&apos;re in your alpha grace period until{" "}
            {formatDate(subscription.grandfatheredUntil)}. Quotas are not
            enforced until then.
          </p>
        </div>
      </BannerShell>
    );
  }

  return null;
}

function BannerShell({
  tone,
  children,
}: {
  tone: "destructive" | "warning" | "muted" | "info";
  children: React.ReactNode;
}) {
  const styles = {
    destructive:
      "ring-destructive/30 bg-destructive/5 text-destructive-foreground",
    warning: "ring-amber-500/40 bg-amber-500/5",
    muted: "ring-foreground/15 bg-muted/40",
    info: "ring-primary/30 bg-primary/5",
  } as const;
  const Icon =
    tone === "destructive"
      ? WarningCircle
      : tone === "warning"
        ? Warning
        : tone === "info"
          ? WarningCircle
          : WarningCircle;
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3 ring-1 text-sm",
        styles[tone],
      )}
    >
      <Icon
        className={cn(
          "size-4 mt-0.5 shrink-0",
          tone === "destructive" && "text-destructive",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
          tone === "info" && "text-primary",
          tone === "muted" && "text-muted-foreground",
        )}
      />
      {children}
    </div>
  );
}

// ───────────────────────── current plan ─────────────────────────

function CurrentPlanCard({ subscription }: { subscription: Subscription }) {
  const portal = usePortal();
  const sync = useSyncBilling();
  const cancel = useCancelSubscription();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const tier = TIERS[subscription.tier];
  const price = tier.price;
  const renewalLine = (() => {
    if (subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd) {
      return `Cancels on ${formatDate(subscription.currentPeriodEnd)}`;
    }
    if (subscription.currentPeriodEnd) {
      return `Renews ${formatDate(subscription.currentPeriodEnd)}`;
    }
    return "No renewal scheduled";
  })();

  async function openPortal() {
    try {
      const { url } = await portal.mutateAsync();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Couldn't open the billing portal.",
      );
    }
  }

  async function handleSync() {
    try {
      await sync.mutateAsync();
      toast.success("Billing synced.");
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Sync failed.",
      );
    }
  }

  async function handleCancel() {
    try {
      await cancel.mutateAsync();
      toast.success(
        "Cancelled. Your plan stays active until the period ends.",
      );
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Couldn't cancel.",
      );
    }
  }

  const canCancel =
    subscription.tier !== "free" &&
    !subscription.cancelAtPeriodEnd &&
    subscription.status !== "cancelled" &&
    subscription.status !== "expired";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Current plan</CardTitle>
        <CardDescription>
          Your active subscription with letmepost.dev.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-3xl font-semibold tabular-nums">
            {tier.name}
          </span>
          {price !== null ? (
            <span className="text-sm text-muted-foreground tabular-nums">
              ${price}/mo
            </span>
          ) : null}
          {subscription.status !== "free" && subscription.status !== "active" ? (
            <Badge variant="outline" className="capitalize">
              {subscription.status.replace("_", " ")}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{renewalLine}</p>
      </CardContent>
      <CardFooter className="border-t flex-wrap gap-2">
        <Button asChild>
          <Link href="/billing/upgrade">
            Change plan
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
        {subscription.tier !== "free" ? (
          <Button
            variant="outline"
            onClick={openPortal}
            disabled={portal.isPending}
          >
            Manage billing
            <ArrowSquareOut className="size-3.5" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSync}
          disabled={sync.isPending}
        >
          <ArrowsClockwise className="size-3.5" />
          {sync.isPending ? "Syncing…" : "Sync billing"}
        </Button>
        {canCancel ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive ml-auto"
            onClick={() => setConfirmCancel(true)}
          >
            Cancel subscription
          </Button>
        ) : null}
      </CardFooter>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel your subscription?"
        description={
          <>
            Your <span className="font-medium text-foreground">{tier.name}</span>{" "}
            plan stays active until{" "}
            {formatDate(subscription.currentPeriodEnd)}. After that you&apos;ll
            be moved to Free. You can reactivate anytime before then.
          </>
        }
        confirmLabel="Cancel subscription"
        cancelLabel="Keep my plan"
        variant="destructive"
        onConfirm={handleCancel}
      />
    </Card>
  );
}

// ───────────────────────── usage ─────────────────────────

function UsageCard({ subscription }: { subscription: Subscription }) {
  const usage = useUsage();

  if (usage.isLoading) {
    return <Skeleton className="h-32" />;
  }
  if (!usage.data) return null;

  return <UsageCardInner usage={usage.data} subscription={subscription} />;
}

function UsageCardInner({
  usage,
  subscription,
}: {
  usage: Usage;
  subscription: Subscription;
}) {
  const unlimited = isUnlimitedQuota(usage.quota);
  const percent = Math.max(0, Math.min(100, usage.percent));
  const tone: "ok" | "warn" | "max" =
    percent >= 100 ? "max" : percent >= 80 ? "warn" : "ok";

  const tier = TIERS[subscription.tier];
  const showWarning = !unlimited && percent >= 80 && subscription.tier !== "business";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage this period</CardTitle>
        <CardDescription>
          Posts published count against your monthly quota. Logs and webhooks
          don&apos;t.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div className="text-2xl font-semibold tabular-nums">
            {usage.postsCount.toLocaleString()}
            <span className="text-muted-foreground"> / </span>
            <span className="text-muted-foreground">
              {unlimited ? "Unlimited" : usage.quota.toLocaleString()}
            </span>
          </div>
          {!unlimited ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {percent.toFixed(0)}%
            </span>
          ) : null}
        </div>

        {!unlimited ? (
          <ProgressBar percent={percent} tone={tone} />
        ) : null}

        <p className="text-xs text-muted-foreground tabular-nums">
          Resets {formatDate(usage.resetAt)} UTC.
        </p>

        {showWarning ? (
          <div
            className={cn(
              "flex items-start gap-2 px-3 py-2 ring-1 text-xs",
              tone === "max"
                ? "ring-destructive/30 bg-destructive/5 text-destructive"
                : "ring-amber-500/40 bg-amber-500/5",
            )}
          >
            <Warning className="size-3.5 mt-0.5 shrink-0" />
            <span>
              You&apos;re at {percent.toFixed(0)}% of your monthly cap on the{" "}
              {tier.name} plan. Consider upgrading.
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ProgressBar({
  percent,
  tone,
}: {
  percent: number;
  tone: "ok" | "warn" | "max";
}) {
  const color =
    tone === "max"
      ? "bg-destructive"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-primary";
  return (
    <div className="h-2 bg-muted relative overflow-hidden">
      <div
        className={cn("absolute inset-y-0 left-0 transition-[width]", color)}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

// ───────────────────────── invoices ─────────────────────────

function InvoicesSection() {
  const invoices = useInvoices();
  const pages = invoices.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.data);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoices.</CardTitle>
        <CardDescription>
          Lemon Squeezy handles invoice issuance. Download PDFs here or from
          the billing portal.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {invoices.isLoading ? (
          <div className="px-4 space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : invoices.error ? (
          <p className="px-4 text-xs text-muted-foreground">
            Couldn&apos;t load invoices.{" "}
            {invoices.error instanceof ApiRequestError
              ? invoices.error.payload.message
              : invoices.error instanceof Error
                ? invoices.error.message
                : "Try again later."}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 text-xs text-muted-foreground">
            No invoices yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Download</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-mono text-xs">
                    {inv.number}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs">
                    {formatDate(inv.issuedAt)}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs">
                    {formatMoney(inv.amount, inv.currency)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        inv.status === "paid"
                          ? "default"
                          : inv.status === "refunded" || inv.status === "void"
                            ? "outline"
                            : "secondary"
                      }
                      className="capitalize"
                    >
                      {inv.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {inv.pdfUrl ? (
                      <Button asChild variant="ghost" size="sm">
                        <a
                          href={inv.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Download className="size-3.5" />
                          PDF
                        </a>
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {invoices.hasNextPage ? (
        <CardFooter className="border-t justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => invoices.fetchNextPage()}
            disabled={invoices.isFetchingNextPage}
          >
            {invoices.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
