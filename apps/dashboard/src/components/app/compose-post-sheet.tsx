"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Plus,
  Lightning,
  Clock,
  Stack,
  FileText,
  Image as ImageIcon,
  Trash,
} from "@phosphor-icons/react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { useActiveProfile } from "@/lib/profiles";
import { queryKeys } from "@/lib/query-keys";
import { track } from "@/lib/analytics";
import { PLATFORM_BRANDS } from "@/components/app/platform-icons";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Account = {
  id: string;
  platform: string;
  displayName?: string;
  handle?: string;
  platformAccountId?: string;
};

type Tab = "schedule" | "now" | "queue" | "draft";

type MediaItem = {
  id: string;
  contentType: string;
  url: string;
  sizeBytes: number;
};

const MAX_MEDIA_PER_POST = 4;

export function ComposePostSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const { profiles, activeProfile, setActiveProfile } = useActiveProfile();
  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );

  const [text, setText] = useState("");
  const [tab, setTab] = useState<Tab>("schedule");
  const [when, setWhen] = useState<Date | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    new Set(),
  );
  const [media, setMedia] = useState<MediaItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText("");
      setMedia([]);
      setSelectedAccountIds(new Set());
      setTab("schedule");
      // Default scheduled time: 1h from now, rounded to next 5 min so
      // the picker lands on a slot that's in the dropdown.
      const t = new Date(Date.now() + 60 * 60 * 1000);
      t.setMinutes(Math.ceil(t.getMinutes() / 5) * 5, 0, 0);
      setWhen(t);
    }
  }, [open]);

  const accountsQuery = useQuery({
    queryKey: queryKeys.accounts.list(activeProfile?.id ?? null),
    queryFn: async () => {
      const url = activeProfile
        ? `/v1/accounts?profileId=${activeProfile.id}`
        : "/v1/accounts";
      const res = await apiFetch<{ data: Account[] }>(url);
      return res.data;
    },
    enabled: open,
  });

  const accounts = accountsQuery.data ?? [];

  useEffect(() => {
    if (accounts.length > 0 && selectedAccountIds.size === 0) {
      setSelectedAccountIds(new Set(accounts.map((a) => a.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsQuery.data?.length]);

  const uploadMedia = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return apiFetch<MediaItem>("/v1/media", {
        method: "POST",
        body: form,
      });
    },
    onSuccess: (m) => {
      setMedia((prev) => [...prev, m]);
      // The upload is persisted server-side, so the Media page list is now
      // stale — refresh it.
      qc.invalidateQueries({ queryKey: ["media"] });
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Upload failed",
      );
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const targets = Array.from(selectedAccountIds).map((accountId) => {
        const acct = accounts.find((a) => a.id === accountId);
        return {
          accountId,
          ...(acct ? { platform: acct.platform } : {}),
        };
      });
      const body: Record<string, unknown> = {
        text,
        targets,
        ...(activeProfile ? { profileId: activeProfile.id } : {}),
      };
      if (tab === "schedule") {
        if (!when) throw new Error("Pick a date and time first.");
        body.scheduledAt = when.toISOString();
      } else {
        body.publishNow = true;
      }
      if (media.length > 0) {
        body.media = media.map((m) => ({
          kind: m.contentType.startsWith("video") ? "video" : "image",
          url: m.url,
        }));
      }
      return apiFetch<{ id: string }>("/v1/posts", {
        method: "POST",
        body,
      });
    },
    onSuccess: () => {
      track({
        name: "post.submitted",
        properties: {
          platforms: Array.from(
            new Set(
              accounts
                .filter((a) => selectedAccountIds.has(a.id))
                .map((a) => a.platform as never),
            ),
          ),
          has_media: media.length > 0,
          media_count: media.length,
          scheduled: tab === "schedule",
        },
      });
      toast.success(tab === "schedule" ? "Scheduled" : "Published");
      qc.invalidateQueries({ queryKey: ["posts"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Failed",
      );
    },
  });

  function toggleAccount(id: string) {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestFeature(feature: "queue" | "draft") {
    track({ name: "feature.requested", properties: { feature } });
    toast.success(`Got it. ${feature} is on the shortlist.`);
  }

  const ctaLabel =
    tab === "schedule"
      ? "Schedule post"
      : tab === "now"
        ? "Publish now"
        : tab === "queue"
          ? "Add to queue"
          : "Save draft";

  const canSubmit =
    text.trim().length > 0 &&
    selectedAccountIds.size > 0 &&
    (tab !== "schedule" || when != null) &&
    (tab === "schedule" || tab === "now");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[480px] flex flex-col p-0">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle>Create post</SheetTitle>
          <SheetDescription className="sr-only">
            Compose, attach media, and pick where + when it lands.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          <section className="space-y-2">
            <Label className="text-xs uppercase tracking-wide">Profile</Label>
            <Select
              value={activeProfile?.id ?? ""}
              onValueChange={(v) => setActiveProfile(v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          <section className="space-y-2">
            <Label className="text-xs uppercase tracking-wide">
              Post to
            </Label>
            {accountsQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : accounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No accounts connected.{" "}
                <Link href="/accounts" className="underline">
                  Connect one
                </Link>{" "}
                to publish.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {accounts.map((a) => {
                  const selected = selectedAccountIds.has(a.id);
                  const brand = PLATFORM_BRANDS.find(
                    (b) => b.id === a.platform,
                  );
                  const Icon = brand?.Icon;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAccount(a.id)}
                      className={cn(
                        "flex items-center gap-2 rounded-md p-2 ring-1 transition-all text-left text-xs",
                        selected
                          ? "ring-primary bg-primary/5"
                          : "ring-foreground/10 hover:ring-foreground/30",
                      )}
                    >
                      {Icon ? <Icon className="size-4 shrink-0" /> : null}
                      <div className="min-w-0">
                        <p className="font-semibold capitalize truncate">
                          {brand?.label ?? a.platform}
                        </p>
                        <p className="text-muted-foreground truncate">
                          {a.displayName ??
                            a.handle ??
                            a.platformAccountId?.slice(0, 12) ??
                            a.id.slice(0, 8)}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="content" className="text-xs uppercase tracking-wide">
                Content
              </Label>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {text.length}
              </span>
            </div>
            <textarea
              id="content"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="what's on your mind…"
              className="min-h-32 w-full resize-y bg-muted/30 p-3 text-sm outline-none focus:bg-muted/40 transition-colors rounded-md ring-1 ring-foreground/10 focus:ring-foreground/20"
            />
            <div className="flex flex-wrap gap-1.5">
              {media.map((m) => (
                <div
                  key={m.id}
                  className="size-12 rounded-md ring-1 ring-foreground/10 overflow-hidden relative group bg-muted/30"
                >
                  {m.contentType.startsWith("image") ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={m.url}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full grid place-items-center text-[9px] text-muted-foreground">
                      VID
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setMedia((prev) => prev.filter((x) => x.id !== m.id))
                    }
                    className="absolute top-0.5 right-0.5 size-4 grid place-items-center bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Remove media"
                  >
                    <Trash className="size-2.5" />
                  </button>
                </div>
              ))}
              {media.length < MAX_MEDIA_PER_POST ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadMedia.isPending}
                  className="size-12 ring-1 ring-dashed ring-foreground/20 hover:ring-foreground/40 transition-shadow grid place-items-center text-muted-foreground"
                  aria-label="Add media"
                >
                  {uploadMedia.isPending ? (
                    <span className="text-[9px]">…</span>
                  ) : (
                    <ImageIcon className="size-4" />
                  )}
                </button>
              ) : null}
            </div>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*,video/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadMedia.mutate(file);
                if (e.target) e.target.value = "";
              }}
            />
          </section>

          <section className="space-y-2">
            <Label className="text-xs uppercase tracking-wide">
              When
            </Label>
            <div className="grid grid-cols-4 gap-1 p-1 bg-muted/40">
              <TabBtn
                active={tab === "schedule"}
                onClick={() => setTab("schedule")}
                icon={<Clock className="size-3" />}
                label="Schedule"
              />
              <TabBtn
                active={tab === "now"}
                onClick={() => setTab("now")}
                icon={<Lightning className="size-3" />}
                label="Now"
              />
              <TabBtn
                active={tab === "queue"}
                onClick={() => setTab("queue")}
                icon={<Stack className="size-3" />}
                label="Queue"
              />
              <TabBtn
                active={tab === "draft"}
                onClick={() => setTab("draft")}
                icon={<FileText className="size-3" />}
                label="Draft"
              />
            </div>
            <div className="pt-1">
              {tab === "schedule" ? (
                <div className="space-y-1">
                  <DateTimePicker
                    value={when}
                    onChange={setWhen}
                    minDate={new Date(Date.now() + 60_000)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Your timezone: <span className="font-mono">{tz}</span>
                  </p>
                </div>
              ) : tab === "now" ? (
                <p className="text-xs text-muted-foreground">
                  Publish immediately to every selected account. Per-target
                  failures don't block the others.
                </p>
              ) : (
                <ComingSoonState
                  feature={tab}
                  onRequest={() => requestFeature(tab)}
                />
              )}
            </div>
          </section>
        </div>

        <div className="px-4 py-3 border-t flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {tab === "schedule" || tab === "now" ? (
            <Button
              size="sm"
              disabled={!canSubmit || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? "Working…" : ctaLabel}
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 py-1.5 text-xs transition-colors",
        active
          ? "bg-background rounded-md ring-1 ring-foreground/10 font-semibold"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function ComingSoonState({
  feature,
  onRequest,
}: {
  feature: "queue" | "draft";
  onRequest: () => void;
}) {
  const [requested, setRequested] = useState(false);
  const copy =
    feature === "queue"
      ? {
          title: "Queues — coming soon",
          desc: "Save a per-profile slot template and drop content into the next free slot. Vote to bump it.",
        }
      : {
          title: "Drafts — coming soon",
          desc: "Keep half-written posts around without scheduling them. Vote to bump it.",
        };
  return (
    <div className="ring-1 ring-dashed ring-foreground/15 p-3 text-center space-y-2">
      <p className="text-sm font-semibold">{copy.title}</p>
      <p className="text-xs text-muted-foreground">{copy.desc}</p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          onRequest();
          setRequested(true);
        }}
        disabled={requested}
      >
        <Plus className="size-3" />
        {requested ? "Vote counted" : "I want this"}
      </Button>
    </div>
  );
}
