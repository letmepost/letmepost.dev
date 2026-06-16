"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowsClockwise, Lightning } from "@phosphor-icons/react";
import { toast } from "sonner";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/lib/webhooks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

type TestResult = {
  delivered: boolean;
  status: number;
  durationMs: number;
  responseBody: string | null;
  deliveryId: string;
  nonRetryable: boolean;
  errorName: string | null;
  sentEvent: unknown;
};

const DEFAULT_DATA: Record<WebhookEventType, unknown> = {
  "post.queued": {
    postId: "00000000-0000-0000-0000-000000000000",
    platform: "bluesky",
    status: "queued",
    text: "Test webhook from letmepost.dev",
  },
  "post.validated": {
    postId: "00000000-0000-0000-0000-000000000000",
    platform: "bluesky",
    status: "validated",
  },
  "post.published": {
    postId: "00000000-0000-0000-0000-000000000000",
    platform: "bluesky",
    status: "published",
    text: "Test webhook from letmepost.dev",
    publishedAt: new Date().toISOString(),
    platformUri: "at://did:plc:test/app.bsky.feed.post/test",
  },
  "post.rejected": {
    postId: "00000000-0000-0000-0000-000000000000",
    platform: "linkedin",
    status: "rejected",
    error: {
      code: "platform_rejected",
      rule: "linkedin.duplicate",
      message: "Duplicate share detected.",
    },
  },
  "post.failed": {
    postId: "00000000-0000-0000-0000-000000000000",
    platform: "linkedin",
    status: "failed",
    error: {
      code: "preflight_failed",
      rule: "linkedin.text.grapheme_count",
      message: "Post exceeds 3,000-grapheme limit.",
    },
  },
  "token.expiring": {
    accountId: "00000000-0000-0000-0000-000000000000",
    platform: "linkedin",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
  "token.revoked": {
    accountId: "00000000-0000-0000-0000-000000000000",
    platform: "linkedin",
    revokedAt: new Date().toISOString(),
  },
  "version.deprecated": {
    platform: "linkedin",
    version: "202304",
    sunsetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    upgradeTo: "202504",
  },
};

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Test-deliver dialog. Picks a synthetic event type, lets the user edit the
 * `data` payload as JSON, fires `POST /v1/webhook-endpoints/:id/test`, and
 * surfaces the consumer's response inline (status, duration, body).
 *
 * The dialog stays open after a send so the operator can iterate — change
 * the type, tweak the payload, send again. Closing it resets state.
 */
export function WebhookTestDialog({
  open,
  onOpenChange,
  endpointId,
  endpointUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpointId: string | null;
  endpointUrl: string | null;
}) {
  const [type, setType] = useState<WebhookEventType>("post.published");
  const [json, setJson] = useState<string>(pretty(DEFAULT_DATA["post.published"]));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  // Reset payload to the new type's default when the user picks a different
  // event — but only if they haven't customized the body, to avoid clobbering
  // edits. We detect "untouched" by re-stringifying the previous default.
  useEffect(() => {
    setResult(null);
  }, [endpointId]);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setSending(false);
    }
  }, [open]);

  function pickType(next: WebhookEventType) {
    const previousDefault = pretty(DEFAULT_DATA[type]);
    if (json === previousDefault) {
      // Body is still the previous-type default — safe to swap.
      setJson(pretty(DEFAULT_DATA[next]));
    }
    setType(next);
    setJsonError(null);
  }

  function resetBody() {
    setJson(pretty(DEFAULT_DATA[type]));
    setJsonError(null);
  }

  async function send() {
    if (!endpointId) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      setJsonError(
        err instanceof Error ? err.message : "Invalid JSON.",
      );
      return;
    }
    setJsonError(null);
    setSending(true);
    setResult(null);
    track({
      name: "webhook.test_sent",
      properties: { event_type: type },
    });
    try {
      const res = await apiFetch<TestResult>(
        `/v1/webhook-endpoints/${endpointId}/test`,
        { method: "POST", body: { type, data: parsed } },
      );
      setResult(res);
      if (res.delivered) {
        track({
          name: "webhook.test_succeeded",
          properties: { event_type: type, latency_ms: res.durationMs },
        });
        toast.success(`Consumer replied ${res.status} in ${res.durationMs}ms.`);
      } else {
        track({
          name: "webhook.test_failed",
          properties: {
            event_type: type,
            status_code: res.status === 0 ? undefined : res.status,
            error_code: res.errorName ?? undefined,
          },
        });
        toast.warning(
          res.status === 0
            ? `Network error (${res.errorName ?? "unknown"})`
            : `Consumer replied ${res.status} in ${res.durationMs}ms.`,
        );
      }
    } catch (err) {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Test delivery failed.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send test event</DialogTitle>
          <DialogDescription>
            Fires a synthetic event at{" "}
            <span className="font-mono break-all">{endpointUrl}</span>. Signed
            with the real signing secret so your handler's HMAC verification
            runs the same path production would.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="test-type">Event type</Label>
            <Select
              value={type}
              onValueChange={(v) => pickType(v as WebhookEventType)}
            >
              <SelectTrigger id="test-type" className="h-9 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEBHOOK_EVENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="font-mono text-xs">
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="test-body">Event data (JSON)</Label>
              <button
                type="button"
                onClick={resetBody}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                reset to default
              </button>
            </div>
            <textarea
              id="test-body"
              value={json}
              onChange={(e) => {
                setJson(e.target.value);
                if (jsonError) setJsonError(null);
              }}
              spellCheck={false}
              className={cn(
                "w-full min-h-[200px] rounded-md bg-muted px-3 py-2 font-mono text-xs",
                "rounded-md ring-1 ring-foreground/10 focus:ring-foreground/40 outline-none",
                "transition-[box-shadow] resize-y",
                jsonError && "ring-destructive focus:ring-destructive",
              )}
            />
            {jsonError ? (
              <p className="text-xs text-destructive">{jsonError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Wrapped in the standard envelope (id, type, createdAt,
                organizationId, data) before signing.
              </p>
            )}
          </div>

          {result ? (
            <motion.div
              key={result.deliveryId}
              initial={{ opacity: 0, y: 4, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-2"
            >
              <div className="flex items-center gap-2">
                {result.delivered ? (
                  <Badge variant="default">delivered</Badge>
                ) : result.nonRetryable ? (
                  <Badge variant="destructive">rejected</Badge>
                ) : result.status === 0 ? (
                  <Badge variant="destructive">network error</Badge>
                ) : (
                  <Badge variant="destructive">5xx</Badge>
                )}
                <Badge variant="outline" className="font-mono text-[10px]">
                  {result.status === 0 ? "no response" : `HTTP ${result.status}`}
                </Badge>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {result.durationMs}ms
                </Badge>
              </div>
              {result.errorName ? (
                <p className="text-xs text-destructive">
                  {result.errorName}
                </p>
              ) : null}
              {result.responseBody ? (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    Consumer response body
                  </div>
                  <pre className="rounded-md bg-muted px-3 py-2 text-xs overflow-x-auto whitespace-pre-wrap break-all font-mono max-h-32">
                    {result.responseBody}
                  </pre>
                </div>
              ) : null}
            </motion.div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={send} disabled={sending}>
            {sending ? (
              <ArrowsClockwise className="size-4 animate-spin" />
            ) : (
              <Lightning className="size-4" />
            )}
            {sending ? "Sending…" : "Send test"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
