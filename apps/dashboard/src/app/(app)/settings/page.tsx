"use client";

import { useState } from "react";
import {
  UserCircle,
  ArrowSquareOut,
  Warning,
  TrendUp,
  Users,
} from "@phosphor-icons/react";
import { authClient } from "@/lib/auth-client";
import { isUnlimitedQuota, useSubscription, useUsage } from "@/lib/billing";
import { useActiveProfile } from "@/lib/profiles";

const TIER_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
  self_host: "Self-host",
};
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-xs text-muted-foreground">
          Manage your usage, profile, and account.
        </p>
      </div>
      <Tabs defaultValue="usage" className="space-y-4">
        <TabsList>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="danger" className="text-destructive">
            Danger Zone
          </TabsTrigger>
        </TabsList>
        <TabsContent value="usage">
          <UsageTab />
        </TabsContent>
        <TabsContent value="profile">
          <ProfileTab />
        </TabsContent>
        <TabsContent value="danger">
          <DangerTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function UsageTab() {
  const sub = useSubscription();
  const usage = useUsage();
  const { profiles } = useActiveProfile();

  if (sub.isLoading || usage.isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }
  if (!sub.data || !usage.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't load usage data. Refresh the page.
      </p>
    );
  }
  const unlimited = isUnlimitedQuota(usage.data.quota);
  const percent = Math.max(0, Math.min(100, usage.data.percent ?? 0));
  const tier = sub.data.tier;
  const tierLabel = TIER_LABELS[tier] ?? tier;

  const resetLabel = (() => {
    const d = new Date(usage.data.resetAt);
    if (Number.isNaN(d.getTime())) return "soon";
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  })();

  const profileCount = profiles?.length ?? 0;
  // Soft caps surfaced on the marketing site — only Free actually enforces
  // a profile limit today; Pro+ have generous defaults.
  const profileCap = tier === "free" ? 2 : tier === "pro" ? 10 : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>
          Current billing cycle on <span className="font-semibold">{tierLabel}</span>.
          Resets {resetLabel}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <MeterTile
          icon={<TrendUp className="size-4" />}
          label="Posts published"
          current={usage.data.postsCount}
          cap={unlimited ? null : usage.data.quota}
          percent={percent}
        />
        <MeterTile
          icon={<Users className="size-4" />}
          label="Profiles"
          current={profileCount}
          cap={profileCap}
        />
        <div className="md:col-span-2 flex items-center justify-between border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Need more? Upgrade for higher limits and priority support.
          </p>
          <Button asChild size="sm" variant="outline">
            <a href="/billing">
              Manage billing
              <ArrowSquareOut className="size-3 ml-1" />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MeterTile({
  icon,
  label,
  current,
  cap,
  percent,
}: {
  icon: React.ReactNode;
  label: string;
  current: number;
  cap: number | null;
  percent?: number;
}) {
  const ratio = cap != null && cap > 0 ? (current / cap) * 100 : 0;
  const display = percent ?? ratio;
  const tone =
    display >= 100 ? "destructive" : display >= 80 ? "warn" : "ok";
  const barColor =
    tone === "destructive"
      ? "bg-destructive"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-primary";
  return (
    <div className="rounded-md ring-1 ring-foreground/10 p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="tabular-nums font-mono">
          {current.toLocaleString()}
          {cap == null ? " / ∞" : ` / ${cap.toLocaleString()}`}
        </span>
      </div>
      {cap != null ? (
        <div className="h-1.5 bg-muted overflow-hidden">
          <div
            className={cn("h-full transition-all", barColor)}
            style={{ width: `${Math.min(100, display)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ProfileTab() {
  const session = authClient.useSession();
  if (session.isPending) {
    return <Skeleton className="h-32 w-full" />;
  }
  const user = session.data?.user;
  if (!user) {
    return (
      <p className="text-sm text-muted-foreground">
        Not signed in.
      </p>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          Your account identity across letmepost.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Avatar className="size-12">
            {user.image ? <AvatarImage src={user.image} alt="" /> : null}
            <AvatarFallback>
              <UserCircle className="size-6" />
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{user.name}</p>
            <p className="text-xs text-muted-foreground truncate">{user.email}</p>
          </div>
        </div>
        <Separator />
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={user.name ?? ""} disabled />
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={user.email} disabled />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Name and email changes go through{" "}
          <a
            href="mailto:support@letmepost.dev"
            className="underline hover:text-foreground"
          >
            support@letmepost.dev
          </a>{" "}
          while we wire up self-serve edits.
        </p>
      </CardContent>
    </Card>
  );
}

function DangerTab() {
  const [confirming, setConfirming] = useState(false);
  const session = authClient.useSession();
  const email = session.data?.user.email ?? "";

  return (
    <Card className="ring-1 ring-destructive/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <Warning className="size-4" />
          Delete account
        </CardTitle>
        <CardDescription>
          Permanently delete your account, organizations you own, every
          connected platform account, every API key, and every scheduled
          post. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!confirming ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Delete my account
          </Button>
        ) : (
          <div className="space-y-3 ring-1 ring-destructive/30 p-3">
            <p className="text-xs">
              Self-serve deletion isn't wired up yet. Email{" "}
              <a
                href={`mailto:support@letmepost.dev?subject=Delete%20my%20account&body=Please%20delete%20the%20account%20for%20${encodeURIComponent(email)}.`}
                className="font-semibold underline hover:text-foreground"
              >
                support@letmepost.dev
              </a>{" "}
              from your account email and we'll process it within 48 hours.
              We'll respond with confirmation before anything is erased.
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button asChild size="sm" variant="destructive">
                <a
                  href={`mailto:support@letmepost.dev?subject=Delete%20my%20account&body=Please%20delete%20the%20account%20for%20${encodeURIComponent(email)}.`}
                >
                  Email support
                </a>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
