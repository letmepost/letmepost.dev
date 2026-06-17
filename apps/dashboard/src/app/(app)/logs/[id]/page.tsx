"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowSquareOut, Clipboard } from "@phosphor-icons/react";
import { toast } from "sonner";
import { slugifyRule } from "@letmepost/schemas";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { getPost, statusTone, type PostDetail } from "@/lib/posts";
import { API_URL, DOCS_URL } from "@/lib/env";
import { queryKeys } from "@/lib/query-keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { track } from "@/lib/analytics";

/**
 * Post detail — the full error contract, raw upstream response, and the
 * timeline of attempts. This is where the "fails loudly" promise becomes
 * visible to the operator. Don't truncate, don't summarize.
 */
export default function PostDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const query = useQuery({
    queryKey: queryKeys.posts.detail(id),
    queryFn: () => getPost(id),
    enabled: !!id,
  });
  const post = query.data ?? null;

  // Fire `post_detail.viewed` once per post id load. The query cache
  // means navigating away and back doesn't refire, but a hard reload
  // does — same semantics as PostHog's `$pageview`.
  useEffect(() => {
    if (!post) return;
    track({
      name: "post_detail.viewed",
      properties: { status: post.status },
    });
  }, [post?.id, post?.status]);

  const error = query.error
    ? query.error instanceof ApiRequestError
      ? query.error.payload.message
      : query.error instanceof Error
        ? query.error.message
        : "Failed to load post."
    : null;

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/logs">
          <ArrowLeft className="size-4" />
          Back to log
        </Link>
      </Button>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load post</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : post === null ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <>
          <Header post={post} />
          {post.error ? <ErrorContract error={post.error} /> : null}
          <RecordSummary post={post} />
          {post.attempts.length > 0 ? (
            <Attempts attempts={post.attempts} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Attempts</CardTitle>
                <CardDescription>
                  Per-attempt history is captured for retried posts. This post
                  hasn&apos;t recorded individual attempts yet. The canonical
                  state above is what we have.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
          <CopyAsCurl post={post} />
        </>
      )}
    </div>
  );
}

function Header({ post }: { post: PostDetail }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="uppercase tracking-wide">
          {post.platform}
        </Badge>
        <Badge variant={statusTone(post.status)}>{post.status}</Badge>
        {post.error?.code ? (
          <Badge variant="outline" className="font-mono">
            {post.error.code}
          </Badge>
        ) : null}
      </div>
      <h1 className="text-base font-semibold whitespace-pre-wrap break-words">
        {post.text}
      </h1>
      <div className="text-xs text-muted-foreground">
        {post.account.displayName ?? post.account.platformAccountId} ·{" "}
        {new Date(post.publishedAt ?? post.createdAt).toLocaleString()}
      </div>
    </div>
  );
}

function ErrorContract({ error }: { error: NonNullable<PostDetail["error"]> }) {
  // The API stamps `docUrl` and `ruleUrl` onto live error responses but
  // doesn't persist them on the row — they're computed from `code` and
  // `rule` at response time. Mirror that computation here so the post-log
  // surface carries the same links a live caller sees.
  const docUrl = error.code ? `${DOCS_URL}/errors/${error.code}` : null;
  const ruleUrl = error.rule
    ? `${DOCS_URL}/preflight/${slugifyRule(error.rule)}`
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-destructive">Error</CardTitle>
        <CardDescription>
          The full error contract. Code, rule, upstream response, remediation.
          Same shape your client SDK receives.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <LinkField
          label="Code"
          value={error.code}
          href={docUrl}
          description="Stable error code — links to the docs page."
        />
        {error.rule ? (
          <LinkField
            label="Rule"
            value={error.rule}
            href={ruleUrl}
            description="Specific rule that fired — links to its preflight page."
          />
        ) : null}
        {error.platform ? (
          <Field label="Platform" value={error.platform} />
        ) : null}
        {error.platformVersion ? (
          <Field label="Platform version" value={error.platformVersion} mono />
        ) : null}
        {error.message ? (
          <Field label="Message" value={error.message} />
        ) : null}
        {error.remediation ? (
          <Field
            label="Remediation"
            value={error.remediation}
            description="Suggested fix"
          />
        ) : null}
        {error.platformResponse !== undefined ? (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">
              Raw platform response
            </div>
            <pre className="rounded-md bg-muted px-3 py-2 text-xs overflow-x-auto whitespace-pre-wrap break-all font-mono">
              {JSON.stringify(error.platformResponse, null, 2)}
            </pre>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LinkField({
  label,
  value,
  href,
  description,
}: {
  label: string;
  value: string;
  href: string | null;
  description?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-sm underline-offset-4 hover:underline"
        >
          {value}
          <ArrowSquareOut className="size-3.5 opacity-70" weight="bold" />
        </a>
      ) : (
        <div className="font-mono text-sm">{value}</div>
      )}
      {description ? (
        <div className="text-xs text-muted-foreground">{description}</div>
      ) : null}
    </div>
  );
}

function RecordSummary({ post }: { post: PostDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Record</CardTitle>
        <CardDescription>Lifecycle + identifiers.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="Post id" value={post.id} mono />
        <Field label="Account" value={post.accountId} mono />
        <Field label="Profile" value={post.profileId} mono />
        {post.platformUri ? (
          <Field label="Platform URI" value={post.platformUri} mono />
        ) : null}
        {post.platformCid ? (
          <Field label="Platform CID" value={post.platformCid} mono />
        ) : null}
        {post.scheduledAt ? (
          <Field
            label="Scheduled at"
            value={new Date(post.scheduledAt).toLocaleString()}
          />
        ) : null}
        {post.publishedAt ? (
          <Field
            label="Published at"
            value={new Date(post.publishedAt).toLocaleString()}
          />
        ) : null}
        <Field
          label="Created at"
          value={new Date(post.createdAt).toLocaleString()}
        />
      </CardContent>
    </Card>
  );
}

function Attempts({ attempts }: { attempts: PostDetail["attempts"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attempts</CardTitle>
        <CardDescription>
          Per-attempt history. Useful for debugging retried posts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {attempts.map((a, idx) => (
          <div key={a.id}>
            {idx > 0 ? <Separator className="my-3" /> : null}
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono">
                #{a.attemptNumber}
              </Badge>
              {a.succeeded === true ? (
                <Badge variant="default">succeeded</Badge>
              ) : a.succeeded === false ? (
                <Badge variant="destructive">failed</Badge>
              ) : (
                <Badge variant="secondary">in-flight</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Started {new Date(a.startedAt).toLocaleString()}
              {a.finishedAt
                ? ` · Finished ${new Date(a.finishedAt).toLocaleString()}`
                : null}
            </div>
            {a.errorCode ? (
              <div className="mt-2 text-xs">
                <span className="font-mono">{a.errorCode}</span>
                {a.errorMessage ? `: ${a.errorMessage}` : ""}
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  mono,
  description,
}: {
  label: string;
  value: string;
  mono?: boolean;
  description?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`text-sm break-all ${
          mono ? "font-mono text-xs rounded-md bg-muted px-2 py-1" : ""
        }`}
      >
        {value}
      </div>
      {description ? (
        <div className="text-xs text-muted-foreground">{description}</div>
      ) : null}
    </div>
  );
}

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  profileId: string | null;
  revokedAt?: string | null;
};

function CopyAsCurl({ post }: { post: PostDetail }) {
  const [pickedKeyId, setPickedKeyId] = useState<string>("");

  // Pull the user's keys so we can pre-fill the curl with a redacted form
  // of one of their actual keys (prefix…last4). They still need to swap in
  // the plaintext before running, but the placeholder concretely points at
  // a key in their account rather than a generic stub.
  const keysQuery = useQuery({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: () =>
      apiFetch<{ data: ApiKeyRow[] }>("/v1/api-keys").then((r) =>
        (r?.data ?? []).filter((k) => !k.revokedAt),
      ),
  });
  const keys = keysQuery.data ?? [];
  // Default-select the first live key as soon as the list arrives.
  useEffect(() => {
    if (!pickedKeyId && keys[0]) setPickedKeyId(keys[0].id);
  }, [pickedKeyId, keys]);

  const pickedKey = keys.find((k) => k.id === pickedKeyId);
  const keyPlaceholder = pickedKey
    ? `${pickedKey.prefix}${"•".repeat(20)}${pickedKey.last4}`
    : "lmp_live_…";

  const curl = useMemo(() => {
    // Reconstruct the CreatePostRequest from what's persisted on the row.
    // mediaRefs / scheduledAt round-trip because they live on the row;
    // firstComment and per-target options don't (Phase 11 follow-up).
    const body: Record<string, unknown> = {
      targets: [{ accountId: post.accountId }],
      text: post.text,
    };
    if (post.mediaRefs && post.mediaRefs.length > 0) {
      body.media = post.mediaRefs;
    }
    if (post.scheduledAt) {
      body.scheduledAt = post.scheduledAt;
    }
    return `curl -X POST '${API_URL}/v1/posts' \\
  -H 'Authorization: Bearer ${keyPlaceholder}' \\
  -H 'Content-Type: application/json' \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '${JSON.stringify(body, null, 2)}'`;
  }, [post, keyPlaceholder]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(curl);
      toast.success("Copied curl to clipboard.");
    } catch {
      toast.error("Clipboard access denied.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reproduce</CardTitle>
        <CardDescription>
          Same request, ready to paste. The Authorization header carries a
          masked form of one of your real keys. Swap in the plaintext you
          stored at creation before running.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {keys.length > 1 ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">
              Use key
            </span>
            <Select value={pickedKeyId} onValueChange={setPickedKeyId}>
              <SelectTrigger className="h-8 w-[260px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {keys.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.name} ·{" "}
                    <span className="font-mono">
                      {k.prefix}…{k.last4}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <pre className="rounded-md bg-muted px-3 py-2 text-xs overflow-x-auto whitespace-pre-wrap break-all font-mono">
          {curl}
        </pre>
        <Button variant="outline" size="sm" onClick={copy}>
          <Clipboard className="size-4" />
          Copy as curl
        </Button>
      </CardContent>
    </Card>
  );
}
