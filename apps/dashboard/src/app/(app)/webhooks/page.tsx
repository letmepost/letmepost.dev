"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Plus, Trash, Check, Lightning } from "@phosphor-icons/react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/lib/webhooks";
import { WebhookTestDialog } from "@/components/app/webhook-test-dialog";
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
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

type Endpoint = {
  id: string;
  url: string;
  events: string[];
  description?: string | null;
  active: boolean;
  lastDeliveryAt?: string | null;
  lastFailureReason?: string | null;
  createdAt: string;
  updatedAt: string;
};

type CreateResponse = Endpoint & { signingSecret: string };

export default function WebhooksPage() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<Set<WebhookEventType>>(new Set());

  function toggleEvent(ev: WebhookEventType) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  }
  const [secretReveal, setSecretReveal] = useState<CreateResponse | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<Endpoint | null>(null);
  const [testTarget, setTestTarget] = useState<Endpoint | null>(null);

  const query = useQuery({
    queryKey: queryKeys.webhooks.list(),
    queryFn: () =>
      apiFetch<{ data: Endpoint[] }>("/v1/webhook-endpoints").then(
        (r) => r.data ?? [],
      ),
  });
  const endpoints = query.data ?? null;
  const error = query.error
    ? query.error instanceof ApiRequestError
      ? query.error.payload.message
      : query.error instanceof Error
        ? query.error.message
        : "Failed to load."
    : null;

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<CreateResponse>("/v1/webhook-endpoints", {
        method: "POST",
        body: {
          url,
          events: Array.from(events),
          description: description.length > 0 ? description : undefined,
        },
      }),
    onSuccess: (res) => {
      track({
        name: "webhook.endpoint_created",
        properties: { event_count: res.events.length },
      });
      setSecretReveal(res);
      setUrl("");
      setDescription("");
      setEvents(new Set());
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list() });
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

  const deleteMutation = useMutation({
    mutationFn: (endpoint: Endpoint) =>
      apiFetch(`/v1/webhook-endpoints/${endpoint.id}`, { method: "DELETE" }).then(
        () => endpoint,
      ),
    onSuccess: (endpoint) => {
      const ageMs = Date.now() - new Date(endpoint.createdAt).getTime();
      track({
        name: "webhook.endpoint_deleted",
        properties: {
          endpoint_age_days: Math.max(0, Math.round(ageMs / 86400000)),
        },
      });
      toast.success("Endpoint deleted.");
      queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list() });
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

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate();
  }

  async function copySecret() {
    if (!secretReveal) return;
    try {
      await navigator.clipboard.writeText(secretReveal.signingSecret);
      toast.success("Signing secret copied.");
    } catch {
      toast.error("Clipboard access denied.");
    }
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <h1 className="text-lg font-semibold">Webhooks</h1>
        <p className="text-xs text-muted-foreground">
          Subscribe to post lifecycle events. Payloads are HMAC-SHA256 signed.
          The signing secret is shown once at creation.
        </p>
      </FadeIn>

      <Card>
        <CardHeader>
          <CardTitle>New endpoint</CardTitle>
          <CardDescription>
            Pick the events you want delivered to this URL. Leave all
            unselected to receive every event.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleCreate}>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="hook-url">URL</Label>
              <Input
                id="hook-url"
                type="url"
                required
                placeholder="https://example.com/hooks/letmepost"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hook-desc">Description (optional)</Label>
              <Input
                id="hook-desc"
                placeholder="Prod Slack alerter"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label>Events</Label>
                <span className="text-xs text-muted-foreground">
                  {events.size === 0
                    ? "all events"
                    : `${events.size} selected`}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {WEBHOOK_EVENT_TYPES.map((ev) => {
                  const on = events.has(ev);
                  return (
                    <button
                      type="button"
                      key={ev}
                      onClick={() => toggleEvent(ev)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono ring-1 transition-colors",
                        on
                          ? "bg-primary text-primary-foreground ring-primary"
                          : "bg-transparent text-foreground ring-foreground/15 hover:ring-foreground/40 hover:bg-muted/50",
                      )}
                    >
                      {on ? (
                        <Check className="size-3" weight="bold" />
                      ) : null}
                      {ev}
                    </button>
                  );
                })}
              </div>
            </div>
          </CardContent>
          <CardFooter className="justify-end border-t mt-6">
            <Button type="submit" disabled={creating}>
              <Plus className="size-4" />
              {creating ? "Creating…" : "Create endpoint"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <div>
        <h2 className="text-sm font-semibold mb-3">Active endpoints</h2>
        {error ? (
          <Card>
            <CardHeader>
              <CardTitle>Couldn&apos;t load endpoints</CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
          </Card>
        ) : endpoints === null ? (
          <div className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : endpoints.length === 0 ? (
          <p className="text-xs text-muted-foreground">No endpoints yet.</p>
        ) : (
          <StaggerList className="space-y-2">
            {endpoints.map((ep) => (
              <StaggerItem key={ep.id}>
              <Card size="sm">
                <CardContent className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {ep.url}
                      </span>
                      {!ep.active ? (
                        <Badge variant="outline">paused</Badge>
                      ) : null}
                      {ep.events.length > 0 ? (
                        <Badge variant="secondary">
                          {ep.events.length} event
                          {ep.events.length === 1 ? "" : "s"}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">all events</Badge>
                      )}
                    </div>
                    {ep.description ? (
                      <div className="text-xs text-muted-foreground">
                        {ep.description}
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground">
                      Last delivery:{" "}
                      {ep.lastDeliveryAt
                        ? new Date(ep.lastDeliveryAt).toLocaleString()
                        : "—"}
                      {ep.lastFailureReason
                        ? ` · last failure: ${ep.lastFailureReason}`
                        : ""}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTestTarget(ep)}
                  >
                    <Lightning className="size-4" />
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(ep)}
                  >
                    <Trash className="size-4" />
                    Delete
                  </Button>
                </CardContent>
              </Card>
              </StaggerItem>
            ))}
          </StaggerList>
        )}
      </div>

      <Dialog
        open={secretReveal !== null}
        onOpenChange={(open) => {
          if (!open) setSecretReveal(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your signing secret</DialogTitle>
            <DialogDescription>
              Use this to verify HMAC-SHA256 signatures on delivered payloads.
              We won't show it again.
            </DialogDescription>
          </DialogHeader>
          {secretReveal ? (
            <div className="space-y-3">
              <div className="break-all bg-muted px-3 py-2 font-mono text-xs">
                {secretReveal.signingSecret}
              </div>
              <Button variant="outline" onClick={copySecret}>
                <Copy className="size-4" />
                Copy to clipboard
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setSecretReveal(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WebhookTestDialog
        open={testTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTestTarget(null);
        }}
        endpointId={testTarget?.id ?? null}
        endpointUrl={testTarget?.url ?? null}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this endpoint?"
        description={
          pendingDelete ? (
            <>
              Deliveries to{" "}
              <span className="font-medium text-foreground">
                {pendingDelete.url}
              </span>{" "}
              will stop immediately.
            </>
          ) : null
        }
        confirmLabel="Delete endpoint"
        variant="destructive"
        onConfirm={async () => {
          if (pendingDelete) await deleteMutation.mutateAsync(pendingDelete);
        }}
      />
    </div>
  );
}
