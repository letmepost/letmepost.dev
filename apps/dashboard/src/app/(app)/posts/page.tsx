"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowsClockwise,
  Check,
  Clock,
  FunnelSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { ApiRequestError } from "@/lib/api";
import {
  listPosts,
  POST_ERROR_CODES,
  POST_STATUSES,
  type ListPostsFilters,
  type PostErrorCode,
  type PostStatus,
} from "@/lib/posts";
import { CONNECTABLE_PLATFORMS } from "@/lib/accounts";
import { useActiveProfile } from "@/lib/profiles";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/app/motion";
import { PostsTable } from "@/components/app/posts-table";
import { track } from "@/lib/analytics";

/**
 * Post Log — the operator's "where did my post go?" screen.
 *
 * Filters (all server-side via `?` params on /v1/posts):
 *   - profile (defaults to active profile from sidebar)
 *   - platform
 *   - status
 *   - time range (presets + custom)
 *   - error code (multi-select)
 *
 * Pagination via the opaque cursor returned by the API; we keep a stack so
 * "back" works. Refetch fires on tab focus + manual Refresh.
 */

type RangePreset = "24h" | "7d" | "30d" | "all" | "custom";

const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  "24h": "Last 24h",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
  custom: "Custom range",
};

function presetToAfter(preset: RangePreset): string | undefined {
  const now = Date.now();
  switch (preset) {
    case "24h":
      return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case "7d":
      return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "30d":
      return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    default:
      return undefined;
  }
}

export default function PostsPage() {
  const { profiles, activeProfile } = useActiveProfile();

  const [platform, setPlatform] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [profileId, setProfileId] = useState<string>("");
  const [errorCodes, setErrorCodes] = useState<Set<PostErrorCode>>(new Set());

  const [range, setRange] = useState<RangePreset>("30d");
  const [customAfter, setCustomAfter] = useState<string>("");
  const [customBefore, setCustomBefore] = useState<string>("");
  const [customDialogOpen, setCustomDialogOpen] = useState(false);

  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([
    undefined,
  ]);

  // Snap profile filter to the sidebar's active profile until the user
  // explicitly changes the dropdown.
  const [profileTouched, setProfileTouched] = useState(false);
  useEffect(() => {
    if (profileTouched) return;
    setProfileId(activeProfile?.id ?? "");
  }, [activeProfile?.id, profileTouched]);

  const filters = useMemo<ListPostsFilters>(() => {
    const f: ListPostsFilters = { limit: 25 };
    if (platform) f.platform = [platform];
    if (status) f.status = [status as PostStatus];
    if (profileId) f.profileId = profileId;
    if (errorCodes.size > 0) f.errorCode = Array.from(errorCodes);
    if (range === "custom") {
      if (customAfter) f.after = new Date(customAfter).toISOString();
      if (customBefore) f.before = new Date(customBefore).toISOString();
    } else {
      const after = presetToAfter(range);
      if (after) f.after = after;
    }
    const cur = cursorStack[cursorStack.length - 1];
    if (cur) f.cursor = cur;
    return f;
  }, [
    platform,
    status,
    profileId,
    errorCodes,
    range,
    customAfter,
    customBefore,
    cursorStack,
  ]);

  // Filter object goes into the queryKey so each filter combination caches
  // independently; navigating Newer/Older keeps the prior page warm.
  const query = useQuery({
    queryKey: queryKeys.posts.list(filters),
    queryFn: () => listPosts(filters),
  });
  const items = query.data?.data ?? null;
  const nextCursor = query.data?.nextCursor ?? null;
  const error = query.error
    ? query.error instanceof ApiRequestError
      ? query.error.payload.message
      : query.error instanceof Error
        ? query.error.message
        : "Failed to load posts."
    : null;

  const refresh = () => query.refetch();

  function resetCursor() {
    setCursorStack([undefined]);
  }

  function clearFilters() {
    setPlatform("");
    setStatus("");
    setProfileId("");
    setProfileTouched(true);
    setErrorCodes(new Set());
    setRange("30d");
    setCustomAfter("");
    setCustomBefore("");
    resetCursor();
  }

  function toggleErrorCode(code: PostErrorCode) {
    setErrorCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
        track({
          name: "post_log.filtered",
          properties: { filter_field: "error_code", filter_value: code },
        });
      }
      return next;
    });
    resetCursor();
  }

  const hasActiveFilters =
    platform !== "" ||
    status !== "" ||
    profileId !== "" ||
    errorCodes.size > 0 ||
    range !== "30d";
  const onFirstPage = cursorStack.length === 1;
  const isLoading = query.isLoading && items === null;

  return (
    <div className="space-y-4" data-page-wide>
      <FadeIn className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Post log</h1>
          <p className="text-xs text-muted-foreground">
            Every post your org has sent through letmepost. When something
            fails, this is where you see the rule, the upstream response, and
            the remediation.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <ArrowsClockwise
            className={query.isFetching ? "size-4 animate-spin" : "size-4"}
          />
          Refresh
        </Button>
      </FadeIn>

      <div className="flex items-center gap-2 flex-wrap">
        <FunnelSimple className="size-4 text-muted-foreground" />

        {profiles.length > 0 ? (
          <Select
            value={profileId || "all"}
            onValueChange={(v) => {
              setProfileId(v === "all" ? "" : v);
              setProfileTouched(true);
              resetCursor();
            }}
          >
            <SelectTrigger className="h-8 w-[150px]">
              <SelectValue placeholder="Profile" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All profiles</SelectItem>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Select
          value={platform || "all"}
          onValueChange={(v) => {
            setPlatform(v === "all" ? "" : v);
            if (v !== "all") {
              track({
                name: "post_log.filtered",
                properties: { filter_field: "platform", filter_value: v },
              });
            }
            resetCursor();
          }}
        >
          <SelectTrigger className="h-8 w-[150px]">
            <SelectValue placeholder="Platform" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All platforms</SelectItem>
            {CONNECTABLE_PLATFORMS.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={status || "all"}
          onValueChange={(v) => {
            setStatus(v === "all" ? "" : v);
            if (v !== "all") {
              track({
                name: "post_log.filtered",
                properties: { filter_field: "status", filter_value: v },
              });
            }
            resetCursor();
          }}
        >
          <SelectTrigger className="h-8 w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {POST_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={range}
          onValueChange={(v) => {
            const next = v as RangePreset;
            setRange(next);
            if (next === "custom") setCustomDialogOpen(true);
            resetCursor();
          }}
        >
          <SelectTrigger className="h-8 w-[170px]">
            <Clock className="size-3 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(RANGE_PRESET_LABELS) as RangePreset[]).map((p) => (
              <SelectItem key={p} value={p}>
                {RANGE_PRESET_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <WarningCircle className="size-3" />
              {errorCodes.size === 0
                ? "Error code"
                : `${errorCodes.size} code${errorCodes.size === 1 ? "" : "s"}`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Filter by error code</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {POST_ERROR_CODES.map((code) => (
              <DropdownMenuCheckboxItem
                key={code}
                checked={errorCodes.has(code)}
                onCheckedChange={() => toggleErrorCode(code)}
                onSelect={(e) => e.preventDefault()}
                className="font-mono text-xs"
              >
                {code}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-3" />
            Clear
          </Button>
        ) : null}
      </div>

      {/* Active error-code chips, when present — visual reinforcement of
          what's actually filtering the table beyond the dropdown count. */}
      {errorCodes.size > 0 ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {Array.from(errorCodes).map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => toggleErrorCode(code)}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono ring-1 ring-foreground/20 hover:ring-foreground/40 transition-colors"
            >
              <Check className="size-3" weight="bold" />
              {code}
              <X className="size-3" />
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load posts</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : !items || items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No posts in range</CardTitle>
            <CardDescription>
              {hasActiveFilters
                ? "Nothing matches the current filters. Widen the range or clear the filter chips."
                : "Every POST /v1/posts you make lands here. Successes, failures, preflight rejections — the receipt of what actually happened."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <PostsTable posts={items} />
      )}

      {(items?.length ?? 0) > 0 && (nextCursor || !onFirstPage) ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={onFirstPage}
            onClick={() => setCursorStack((s) => s.slice(0, -1))}
          >
            Newer
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!nextCursor}
            onClick={() => {
              if (nextCursor) setCursorStack((s) => [...s, nextCursor]);
            }}
          >
            Older
          </Button>
        </div>
      ) : null}

      <CustomRangeDialog
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
        after={customAfter}
        before={customBefore}
        onApply={(a, b) => {
          setCustomAfter(a);
          setCustomBefore(b);
          setRange("custom");
          resetCursor();
          setCustomDialogOpen(false);
        }}
      />
    </div>
  );
}

function CustomRangeDialog({
  open,
  onOpenChange,
  after,
  before,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  after: string;
  before: string;
  onApply: (after: string, before: string) => void;
}) {
  const [localAfter, setLocalAfter] = useState(after);
  const [localBefore, setLocalBefore] = useState(before);

  useEffect(() => {
    if (open) {
      setLocalAfter(after);
      setLocalBefore(before);
    }
  }, [open, after, before]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Custom range</DialogTitle>
          <DialogDescription>
            Both ends are optional. Leave one blank to filter open-ended in
            that direction.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="range-after">From</Label>
            <Input
              id="range-after"
              type="datetime-local"
              className="h-9"
              value={localAfter}
              onChange={(e) => setLocalAfter(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="range-before">To</Label>
            <Input
              id="range-before"
              type="datetime-local"
              className="h-9"
              value={localBefore}
              onChange={(e) => setLocalBefore(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onApply(localAfter, localBefore)}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
