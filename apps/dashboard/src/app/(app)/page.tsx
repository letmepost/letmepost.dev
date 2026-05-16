"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Broadcast,
  Copy,
  Key,
  Lightning,
  Plug,
  Rocket,
  WarningCircle,
} from "@phosphor-icons/react";
import { authClient } from "@/lib/auth-client";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { API_URL } from "@/lib/env";
import { queryKeys } from "@/lib/query-keys";
import {
  formatRelative,
  listPosts,
  statusTone,
  type PostListItem,
} from "@/lib/posts";
import type { Account } from "@/lib/accounts";
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
import { FadeIn, StaggerList, StaggerItem } from "@/components/app/motion";
import {
  OnboardingChecklist,
  type ChecklistStep,
} from "@/components/app/onboarding-checklist";
import { OnboardingConnect } from "@/components/app/onboarding-connect";
import { PLATFORM_BRANDS } from "@/components/app/platform-icons";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

type Counts = {
  accounts: number | null;
  apiKeys: number | null;
  webhooks: number | null;
  posts: number | null;
};

async function loadList<T>(path: string): Promise<T[]> {
  const res = await apiFetch<{ data?: T[] }>(path);
  return Array.isArray(res?.data) ? res.data : [];
}

export default function DashboardHome() {
  const activeOrg = authClient.useActiveOrganization().data;
  const queryClient = useQueryClient();
  const [latestKey, setLatestKey] = useState<string | null>(null);

  // Fetch the full lists; the count cards derive their numbers from
  // `.length`. Sharing the same queryKey as the dedicated list pages means
  // navigating from /accounts back home doesn't refetch.
  const accountsQ = useQuery({
    queryKey: queryKeys.accounts.list(),
    queryFn: () => loadList<Account>("/v1/accounts"),
  });
  const apiKeysQ = useQuery({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: () => loadList<unknown>("/v1/api-keys"),
  });
  const webhooksQ = useQuery({
    queryKey: queryKeys.webhooks.list(),
    queryFn: () => loadList<unknown>("/v1/webhook-endpoints"),
  });
  // Posts uses limit=1 — we only need a "any?" boolean, not full data.
  const postsQ = useQuery({
    queryKey: queryKeys.posts.list({ limit: 1, _purpose: "count" }),
    queryFn: () => loadList<unknown>("/v1/posts?limit=1"),
  });

  const counts: Counts = {
    accounts: accountsQ.data?.length ?? null,
    apiKeys: apiKeysQ.data?.length ?? null,
    webhooks: webhooksQ.data?.length ?? null,
    posts: postsQ.data?.length ?? null,
  };
  const loaded =
    !accountsQ.isLoading &&
    !apiKeysQ.isLoading &&
    !webhooksQ.isLoading &&
    !postsQ.isLoading;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: queryKeys.accounts.list() });
    queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.list() });
    queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list() });
    queryClient.invalidateQueries({ queryKey: ["posts"] });
  }

  const hasKey = (counts.apiKeys ?? 0) > 0 || latestKey !== null;
  const hasAccount = (counts.accounts ?? 0) > 0;
  const hasPost = (counts.posts ?? 0) > 0;
  const setupComplete = hasKey && hasAccount && hasPost;

  const steps: ChecklistStep[] = [
    {
      id: "api-key",
      title: "Copy your API key",
      description:
        "Bearer token that authenticates every request. Plaintext is shown once.",
      done: hasKey,
      body: (
        <ApiKeyStepBody
          latestKey={latestKey}
          alreadyHasKey={(counts.apiKeys ?? 0) > 0}
          onCreated={(plain) => {
            setLatestKey(plain);
            refresh();
          }}
        />
      ),
    },
    {
      id: "connect",
      title: "Connect your first platform",
      description: "Bluesky, LinkedIn, Pinterest, or Twitter / X.",
      done: hasAccount,
      body: <OnboardingConnect onConnected={refresh} />,
    },
    {
      id: "quick-start",
      title: "Send your first post",
      description: "Curl + post log. End-to-end in under a minute.",
      done: hasPost,
      body: <QuickStartBody apiKey={latestKey} onSent={refresh} />,
    },
  ];

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-lg font-semibold">
            {activeOrg?.name ?? "Dashboard"}
          </h1>
          {setupComplete ? <HealthPills /> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {setupComplete
            ? "Your operator surface — connect accounts, mint API keys, subscribe to webhooks."
            : "A few quick steps and you're publishing."}
        </p>
      </FadeIn>

      <AnimatePresence mode="wait" initial={false}>
        {!loaded ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-2"
          >
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </motion.div>
        ) : !setupComplete ? (
          <motion.div
            key="checklist"
            initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{
              opacity: 0,
              y: -6,
              filter: "blur(6px)",
              transition: { duration: 0.24, ease: EASE_OUT },
            }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
          >
            <OnboardingChecklist steps={steps} />
          </motion.div>
        ) : (
          <motion.div
            key="counts"
            initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
            className="space-y-6"
          >
            <StaggerList className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <StaggerItem>
                <CountCard
                  title="Connected accounts"
                  description="Social platform accounts available to the API."
                  count={counts.accounts}
                />
              </StaggerItem>
              <StaggerItem>
                <CountCard
                  title="API keys"
                  description="Bearer tokens for programmatic API access."
                  count={counts.apiKeys}
                />
              </StaggerItem>
              <StaggerItem>
                <CountCard
                  title="Webhook endpoints"
                  description="Delivery targets for post / token lifecycle events."
                  count={counts.webhooks}
                />
              </StaggerItem>
            </StaggerList>

            <QuickActionsStrip />

            <NeedsAttentionSection
              accounts={accountsQ.data ?? []}
            />


            <div className="grid gap-4 lg:grid-cols-3 items-stretch">
              <div className="lg:col-span-2 flex">
                <RecentActivitySection />
              </div>
              <div className="flex">
                <PlatformBreakdownSection />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CountCard(props: {
  title: string;
  description: string;
  count: number | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {props.count === null ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className="text-3xl font-semibold tabular-nums">
            {props.count}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type ExistingKey = { prefix: string; last4: string };

function ApiKeyStepBody({
  latestKey,
  alreadyHasKey,
  onCreated,
}: {
  latestKey: string | null;
  alreadyHasKey: boolean;
  onCreated: (plaintext: string) => void;
}) {
  const queryClient = useQueryClient();
  // Reuse the apiKeys list cache (already populated by the home page) — when
  // a key already exists but we don't have the plaintext, we pull the masked
  // form from the same query and show it in the muted block.
  const keysQuery = useQuery({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: () => loadList<ExistingKey>("/v1/api-keys"),
    enabled: alreadyHasKey && !latestKey,
  });
  const existing = keysQuery.data?.[0]
    ? {
        prefix: keysQuery.data[0].prefix,
        last4: keysQuery.data[0].last4,
      }
    : null;

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ key: string }>("/v1/api-keys", {
        method: "POST",
        body: { name: "primary", prefix: "lmp_live_", scopes: [] },
      }),
    onSuccess: (res) => {
      onCreated(res.key);
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.list() });
      toast.success("Copy it now — we won't show it again.");
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Couldn't create the key.",
      );
    },
  });
  const creating = createMutation.isPending;

  function handleCreate() {
    createMutation.mutate();
  }

  async function handleCopy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard.");
    } catch {
      toast.error("Clipboard access denied.");
    }
  }

  if (latestKey) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This is the only time we'll show the full key. Copy it and store it
          somewhere secure.
        </p>
        <div className="break-all bg-muted px-3 py-2 font-mono text-xs">
          {latestKey}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleCopy(latestKey)}
        >
          <Copy className="size-4" />
          Copy to clipboard
        </Button>
      </div>
    );
  }

  if (alreadyHasKey) {
    const masked = existing
      ? `${existing.prefix}${"•".repeat(20)}${existing.last4}`
      : "";
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Plaintext is only shown at creation — this is the masked form on
          file. Rotate or add another from the API keys page.
        </p>
        <div className="break-all bg-muted px-3 py-2 font-mono text-xs min-h-[2rem]">
          {existing ? (
            masked
          ) : (
            <Skeleton className="h-4 w-48 inline-block" />
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleCopy(masked)}
          disabled={!existing}
        >
          <Copy className="size-4" />
          Copy to clipboard
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        We'll mint a key called <code>primary</code> with the default scope set.
        You can rotate or add more from the API keys page later.
      </p>
      <Button onClick={handleCreate} disabled={creating}>
        <Rocket className="size-4" />
        {creating ? "Creating…" : "Create my first key"}
      </Button>
    </div>
  );
}

function QuickStartBody({
  apiKey,
  onSent,
}: {
  apiKey: string | null;
  onSent: () => void;
}) {
  const router = useRouter();
  const [sending, setSending] = useState(false);

  // Same queryKey as the dashboard's accounts list — the data's already in
  // cache by the time the user reaches step 3, so this hits the cache.
  const accountsQuery = useQuery({
    queryKey: queryKeys.accounts.list(),
    queryFn: () => loadList<Account>("/v1/accounts"),
  });
  const account = accountsQuery.data?.[0] ?? null;

  const accountId = account?.id ?? "<your-account-id>";
  // Quickstart uses the multi-target shape since that's the v1 surface.
  // `platform` is no longer part of the request body — the API resolves it
  // server-side from the stored account row, which is why a single string
  // accountId is all you need to fan out.
  const example = `curl -X POST ${API_URL}/v1/posts \\
  -H "Authorization: Bearer ${apiKey ?? "lmp_live_…"}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "targets": [{ "accountId": "${accountId}" }],
    "text": "Hello from letmepost.dev"
  }'`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(example);
      toast.success("Copied to clipboard.");
    } catch {
      toast.error("Clipboard access denied.");
    }
  }

  async function handleSend() {
    if (!apiKey || !account) return;
    setSending(true);
    try {
      const res = await fetch(`${API_URL}/v1/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          targets: [{ accountId: account.id }],
          text: "Hello from letmepost.dev",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `Request failed (${res.status})`);
      }
      toast.success("Post queued — opening the log.");
      onSent();
      router.push("/posts");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  // Live-send needs the in-session plaintext key (POST /v1/posts is strict
  // Bearer-auth). If the user already had a key from a prior session and
  // hasn't created a new one here, we can only offer Copy.
  const canSend = apiKey !== null && account !== null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Paste this into your terminal, or fire it now from this page. Either
        way, the result lands in the post log — published or failed.
      </p>
      <pre className="bg-muted px-3 py-3 text-xs font-mono overflow-x-auto whitespace-pre">
        {example}
      </pre>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={handleCopy}>
          <Copy className="size-4" />
          Copy curl
        </Button>
        <Button
          size="sm"
          onClick={handleSend}
          disabled={!canSend || sending}
          title={
            !apiKey
              ? "Create a key in step 1 to enable live send."
              : !account
                ? "Loading your account…"
                : undefined
          }
        >
          <Lightning className="size-4" />
          {sending ? "Sending…" : "Send test post"}
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/posts">
            Open the post log
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
      {!apiKey ? (
        <p className="text-xs text-muted-foreground">
          Live send uses the API key from step 1. If you've already created a
          key in a prior session, copy this curl and run it instead.
        </p>
      ) : null}
    </div>
  );
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Needs attention" surfaces two operator-facing signals on the home page:
 *
 *   1. Posts that failed in the last 24h — the product's pitch is "fails
 *      loudly", so failures get a count + direct link into the filtered
 *      post log. Backed by its own posts query (status=failed, after=24h)
 *      so the home page doesn't have to slurp the full failure list.
 *   2. Account tokens expiring within 7 days. The accounts list is already
 *      cached by the parent — we just filter it client-side.
 *
 * Renders nothing when neither bucket has anything; the home page stays
 * quiet for a healthy org.
 */
function NeedsAttentionSection({ accounts }: { accounts: Account[] }) {
  // Memo'd: a fresh `Date.now()` each render would change the queryKey
  // every render and react-query would never settle on a result.
  const since = useMemo(
    () => new Date(Date.now() - ONE_DAY_MS).toISOString(),
    [],
  );

  const failuresQuery = useQuery({
    queryKey: queryKeys.posts.list({
      limit: 10,
      status: ["failed"],
      after: since,
      _purpose: "needs-attention",
    }),
    queryFn: () =>
      listPosts({ limit: 10, status: ["failed"], after: since }).then(
        (r) => r.data ?? [],
      ),
  });
  const failures = failuresQuery.data ?? [];
  const failureCount = failures.length;
  const showsMore = failureCount === 10;

  if (failureCount === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <WarningCircle className="size-4 text-destructive" />
          <CardTitle>Needs attention</CardTitle>
        </div>
        <CardDescription>
          Things that&apos;ll cost you posts if you ignore them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {failureCount > 0 ? (
          <Link
            href="/posts?status=failed"
            className="flex items-center justify-between gap-3 px-3 py-2 ring-1 ring-foreground/10 hover:ring-foreground/30 hover:bg-muted/40 transition-[box-shadow,background]"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="destructive">
                {showsMore ? "10+" : failureCount}
              </Badge>
              <span className="text-sm">
                failed post{failureCount === 1 ? "" : "s"} in the last 24h
              </span>
            </div>
            <ArrowRight className="size-4 text-muted-foreground shrink-0" />
          </Link>
        ) : null}

      </CardContent>
    </Card>
  );
}

/**
 * Recent activity — last 5 posts as a slim preview, with a "View all" link
 * to the full Post Log. Same `posts.list` query family as the log itself,
 * so the cache is shared.
 */
function RecentActivitySection() {
  const query = useQuery({
    queryKey: queryKeys.posts.list({ limit: 5, _purpose: "recent" }),
    queryFn: () => listPosts({ limit: 5 }).then((r) => r.data ?? []),
  });
  const posts = query.data ?? [];

  return (
    <Card className="flex flex-col w-full">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>
              Last 5 posts — published or failed. Click for the full
              record.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/posts">
              View all
              <ArrowRight className="size-3" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {query.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : posts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No posts yet. Once you publish through the API, recent activity
            shows up here.
          </p>
        ) : (
          <div className="divide-y divide-foreground/10 -mx-2">
            {posts.map((p) => (
              <RecentRow key={p.id} post={p} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentRow({ post }: { post: PostListItem }) {
  const ts = post.publishedAt ?? post.createdAt;
  return (
    <Link
      href={`/posts/${post.id}`}
      className="flex items-center gap-3 px-2 py-2.5 hover:bg-muted/40 transition-colors"
    >
      <Badge variant="outline" className="uppercase tracking-wide shrink-0">
        {post.platform}
      </Badge>
      <Badge variant={statusTone(post.status)} className="shrink-0">
        {post.status}
      </Badge>
      <span className="flex-1 min-w-0 text-sm truncate">{post.text}</span>
      {post.error?.code ? (
        <Badge variant="outline" className="font-mono text-[10px] shrink-0">
          {post.error.code}
        </Badge>
      ) : null}
      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
        {formatRelative(ts)}
      </span>
    </Link>
  );
}

/**
 * Greeting health pills — "X today" + "Y failed in 24h" next to the org
 * name. Both queries share the same keys as Recent Activity / Needs
 * Attention so we don't double-fetch.
 */
function HealthPills() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayQuery = useQuery({
    queryKey: queryKeys.posts.list({
      limit: 50,
      after: todayStart.toISOString(),
      _purpose: "today",
    }),
    queryFn: () =>
      listPosts({ limit: 50, after: todayStart.toISOString() }).then(
        (r) => r.data ?? [],
      ),
  });

  const since24 = useMemo(
    () => new Date(Date.now() - ONE_DAY_MS).toISOString(),
    [],
  );
  const failuresQuery = useQuery({
    queryKey: queryKeys.posts.list({
      limit: 10,
      status: ["failed"],
      after: since24,
      _purpose: "needs-attention",
    }),
    queryFn: () =>
      listPosts({ limit: 10, status: ["failed"], after: since24 }).then(
        (r) => r.data ?? [],
      ),
  });

  if (todayQuery.isLoading && failuresQuery.isLoading) return null;

  const todayCount = todayQuery.data?.length ?? 0;
  const todayCapped = todayCount === 50 ? "50+" : todayCount;
  const failureCount = failuresQuery.data?.length ?? 0;

  return (
    <div className="flex items-center gap-1.5">
      <Badge variant="secondary" className="tabular-nums">
        {todayCapped} today
      </Badge>
      {failureCount > 0 ? (
        <Badge variant="destructive" className="tabular-nums">
          {failureCount === 10 ? "10+" : failureCount} failed in 24h
        </Badge>
      ) : (
        <Badge
          variant="outline"
          className="tabular-nums text-primary ring-1 ring-primary/30"
        >
          all green
        </Badge>
      )}
    </div>
  );
}

/**
 * Quick actions strip — 4 frequent navigation targets the operator wants at
 * arm's length. Plain shadcn-styled cards; click → route. Renders below the
 * count cards so it doesn't fight Needs Attention for prominence.
 */
function QuickActionsStrip() {
  const items: Array<{
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    href: string;
    detail: string;
  }> = [
    {
      icon: Plug,
      label: "Connect platform",
      href: "/accounts/new",
      detail: "Add another account",
    },
    {
      icon: Key,
      label: "Mint API key",
      href: "/api-keys",
      detail: "Org-wide or scoped",
    },
    {
      icon: Lightning,
      label: "Send test webhook",
      href: "/webhooks",
      detail: "Verify your handler",
    },
    {
      icon: Broadcast,
      label: "Subscribe webhook",
      href: "/webhooks",
      detail: "Listen for events",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Link
            key={it.label}
            href={it.href}
            className="flex items-center gap-3 px-3 py-3 ring-1 ring-foreground/10 hover:ring-foreground/40 hover:bg-muted/40 transition-[box-shadow,background] bg-card"
          >
            <Icon className="size-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{it.label}</div>
              <div className="text-[10px] text-muted-foreground truncate">
                {it.detail}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Per-platform breakdown — last 30 days, posts grouped by platform with a
 * brand-colored bar for total volume and a small status legend (published /
 * failed / rejected) below each row. Inline div bars instead of a chart
 * library: keeps the bundle thin and matches the brutalist sharp-corner
 * theme.
 */
function PlatformBreakdownSection() {
  const since = useMemo(
    () => new Date(Date.now() - 30 * ONE_DAY_MS).toISOString(),
    [],
  );
  const query = useQuery({
    queryKey: queryKeys.posts.list({
      limit: 200,
      after: since,
      _purpose: "breakdown",
    }),
    queryFn: () =>
      listPosts({ limit: 200, after: since }).then((r) => r.data ?? []),
  });

  const groups = (() => {
    const all = query.data ?? [];
    return PLATFORM_BRANDS.map((brand) => {
      let published = 0;
      let failed = 0;
      let rejected = 0;
      let other = 0;
      for (const p of all) {
        if (p.platform !== brand.id) continue;
        if (p.status === "published") published++;
        else if (p.status === "failed") failed++;
        else if (p.status === "rejected") rejected++;
        else other++;
      }
      const total = published + failed + rejected + other;
      return { brand, published, failed, rejected, other, total };
    });
  })();
  const max = Math.max(1, ...groups.map((g) => g.total));
  const totalAll = groups.reduce((sum, g) => sum + g.total, 0);

  return (
    <Card className="flex flex-col w-full">
      <CardHeader>
        <CardTitle>By platform</CardTitle>
        <CardDescription>
          Posts in the last 30 days, grouped by platform.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        {query.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : totalAll === 0 ? (
          <p className="text-xs text-muted-foreground">
            No posts in the last 30 days. Widen the time range from the post
            log to look further back.
          </p>
        ) : (
          groups.map((g) => {
            const pct = (g.total / max) * 100;
            const Icon = g.brand.Icon;
            return (
              <div key={g.brand.id} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="size-3.5 shrink-0"
                      style={{ color: g.brand.color }}
                    >
                      <Icon className="size-full" />
                    </span>
                    <span className="text-xs font-medium">
                      {g.brand.label}
                    </span>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {g.total}
                  </span>
                </div>
                <div className="h-1.5 bg-muted relative overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 transition-[width] duration-500"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: g.brand.color,
                    }}
                  />
                </div>
                {g.total > 0 ? (
                  <div className="flex gap-3 text-[10px] tabular-nums text-muted-foreground">
                    <span>✓ {g.published}</span>
                    {g.failed > 0 ? (
                      <span className="text-destructive">✗ {g.failed}</span>
                    ) : null}
                    {g.rejected > 0 ? (
                      <span className="text-destructive">⊘ {g.rejected}</span>
                    ) : null}
                    {g.other > 0 ? <span>· {g.other}</span> : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
