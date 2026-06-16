"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Plus, Trash } from "@phosphor-icons/react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
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
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { FadeIn, StaggerList, StaggerItem } from "@/components/app/motion";
import { useActiveProfile } from "@/lib/profiles";
import { formatRelative } from "@/lib/posts";
import { track } from "@/lib/analytics";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: string[];
  profileId?: string | null;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
};

type CreateResponse = ApiKey & { key: string };

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const { profiles } = useActiveProfile();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState<"lmp_live_" | "lmp_test_">("lmp_live_");
  // "" sentinel = org-wide; otherwise a profile id.
  const [scope, setScope] = useState<string>("");
  const [plaintext, setPlaintext] = useState<CreateResponse | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null);

  const query = useQuery({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: () =>
      apiFetch<{ data: ApiKey[] }>("/v1/api-keys").then((r) => r.data ?? []),
  });
  const keys = query.data ?? null;
  const error = query.error
    ? query.error instanceof ApiRequestError
      ? query.error.payload.message
      : query.error instanceof Error
        ? query.error.message
        : "Failed to load."
    : null;

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<CreateResponse>("/v1/api-keys", {
        method: "POST",
        body: {
          name,
          prefix,
          scopes: [],
          profileId: scope === "" ? null : scope,
        },
      }),
    onSuccess: (res) => {
      track({
        name: "api_key.created",
        properties: {
          environment: res.prefix === "lmp_live_" ? "live" : "test",
          name_provided: res.name.trim().length > 0,
        },
      });
      setPlaintext(res);
      setName("");
      setScope("");
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.list() });
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Create failed.",
      );
    },
  });
  const creating = createMutation.isPending;

  const revokeMutation = useMutation({
    mutationFn: (key: ApiKey) =>
      apiFetch(`/v1/api-keys/${key.id}`, { method: "DELETE" }).then(
        () => key,
      ),
    onSuccess: (key) => {
      const ageMs = Date.now() - new Date(key.createdAt).getTime();
      track({
        name: "api_key.revoked",
        properties: {
          key_age_days: Math.max(0, Math.round(ageMs / 86400000)),
        },
      });
      toast.success("Key revoked.");
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.list() });
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Revoke failed.",
      );
    },
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate();
  }

  async function copyKey() {
    if (!plaintext) return;
    try {
      await navigator.clipboard.writeText(plaintext.key);
      track({
        name: "api_key.copied",
        properties: {
          environment: plaintext.prefix === "lmp_live_" ? "live" : "test",
        },
      });
      toast.success("Copied to clipboard.");
    } catch {
      toast.error("Clipboard access denied.");
    }
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <h1 className="text-lg font-semibold">API keys</h1>
        <p className="text-xs text-muted-foreground">
          Bearer tokens. Plaintext is shown once, right after creation. Store
          it somewhere safe.
        </p>
      </FadeIn>

      <Card>
        <CardHeader>
          <CardTitle>New key</CardTitle>
          <CardDescription>
            A human-readable name helps you identify which deployment uses each
            key.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleCreate}>
          <CardContent
            className={
              profiles.length > 0
                ? "grid gap-4 md:grid-cols-[1fr_180px_220px]"
                : "grid gap-4 md:grid-cols-[1fr_220px]"
            }
          >
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="production-web"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-prefix">Environment</Label>
              <Select
                value={prefix}
                onValueChange={(v) =>
                  setPrefix(v as "lmp_live_" | "lmp_test_")
                }
              >
                <SelectTrigger id="key-prefix" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lmp_live_">Live</SelectItem>
                  <SelectItem value="lmp_test_">Test</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {profiles.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor="key-scope">Scope</Label>
                <Select
                  value={scope === "" ? "__org" : scope}
                  onValueChange={(v) => setScope(v === "__org" ? "" : v)}
                >
                  <SelectTrigger id="key-scope" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__org">Org-wide</SelectItem>
                    {profiles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </CardContent>
          <CardFooter className="justify-end border-t mt-6">
            <Button type="submit" disabled={creating}>
              <Plus className="size-4" />
              {creating ? "Creating…" : "Create key"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <div>
        <h2 className="text-sm font-semibold mb-3">Active keys</h2>
        {error ? (
          <Card>
            <CardHeader>
              <CardTitle>Couldn&apos;t load API keys</CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
          </Card>
        ) : keys === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : keys.length === 0 ? (
          <p className="text-xs text-muted-foreground">No keys yet.</p>
        ) : (
          <StaggerList className="space-y-2">
            {keys.map((k) => (
              <StaggerItem key={k.id}>
              <Card size="sm">
                <CardContent className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {k.name}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {k.prefix.replace(/_$/, "")}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {k.profileId
                          ? profiles.find((p) => p.id === k.profileId)?.name ??
                            "profile"
                          : "org-wide"}
                      </Badge>
                      {k.revokedAt ? (
                        <Badge variant="destructive">revoked</Badge>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {k.prefix}…{k.last4} · created{" "}
                      {new Date(k.createdAt).toLocaleDateString()}
                      {" · "}
                      {k.lastUsedAt
                        ? `used ${formatRelative(k.lastUsedAt)}`
                        : "never used"}
                    </div>
                  </div>
                  {!k.revokedAt ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingRevoke(k)}
                    >
                      <Trash className="size-4" />
                      Revoke
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
              </StaggerItem>
            ))}
          </StaggerList>
        )}
      </div>

      <Dialog
        open={plaintext !== null}
        onOpenChange={(open) => {
          if (!open) setPlaintext(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your API key</DialogTitle>
            <DialogDescription>
              This is the only time we'll show the full key. Copy it now and
              store it somewhere secure.
            </DialogDescription>
          </DialogHeader>
          {plaintext ? (
            <div className="space-y-3">
              <div className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {plaintext.key}
              </div>
              <Button variant="outline" onClick={copyKey}>
                <Copy className="size-4" />
                Copy to clipboard
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setPlaintext(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
        title="Revoke this API key?"
        description={
          pendingRevoke ? (
            <>
              <span className="font-medium text-foreground">
                {pendingRevoke.name}
              </span>{" "}
              will stop working immediately. This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Revoke key"
        variant="destructive"
        onConfirm={async () => {
          if (pendingRevoke) await revokeMutation.mutateAsync(pendingRevoke);
        }}
      />
    </div>
  );
}
