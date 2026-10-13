"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Trash,
  ArrowSquareOut,
  Clock,
  Image as ImageIcon,
} from "@phosphor-icons/react";
import {
  cancelPost,
  updatePost,
  type PostListItem,
  type PostPatch,
} from "@/lib/posts";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PLATFORM_BRANDS } from "@/components/app/platform-icons";

/**
 * Drawer for inspecting and mutating a single scheduled post. Driven by an
 * optional `post` prop; rendered open whenever a post is provided. Used from
 * both /calendar (click chip on day cell) and /posts (compose surface).
 *
 * A queued post is fully editable here — caption, media, and time — and every
 * change goes through one PATCH carrying only the fields that actually moved.
 * Until this existed the drawer could change the time and nothing else, so
 * fixing a typo meant cancelling the post and composing it again.
 */

/**
 * Soft cap on the media strip, mirroring the compose sheet. The real limit is
 * per-platform (Bluesky 4 images, Instagram 10, and so on) and is enforced by
 * the API's preflight, which rejects the PATCH with the platform's own rule.
 */
const MAX_MEDIA_PER_POST = 4;

/** Upload response from `POST /v1/media`. */
type UploadedMedia = {
  id: string;
  contentType: string;
  url: string;
  sizeBytes: number;
};

/**
 * A media attachment as the API stores and accepts it. `url` and `mediaId` are
 * alternative sources — a post created with `mediaId` keeps that shape, so the
 * draft preserves whatever came back rather than rewriting it.
 */
type DraftMedia = {
  kind: "image" | "video";
  url?: string;
  mediaId?: string;
  altText?: string;
};

/** Read the stored `mediaRefs` jsonb into the draft shape, dropping anything
 *  malformed rather than rendering a broken tile. */
function toDraftMedia(refs: unknown[]): DraftMedia[] {
  const out: DraftMedia[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const r = ref as Record<string, unknown>;
    const kind = r.kind === "video" ? "video" : "image";
    const item: DraftMedia = { kind };
    if (typeof r.url === "string") item.url = r.url;
    if (typeof r.mediaId === "string") item.mediaId = r.mediaId;
    if (typeof r.altText === "string") item.altText = r.altText;
    // A ref with neither source can't be re-sent, so it isn't editable.
    if (!item.url && !item.mediaId) continue;
    out.push(item);
  }
  return out;
}

function sameMedia(a: DraftMedia[], b: DraftMedia[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ScheduledPostDrawer({
  post,
  onOpenChange,
}: {
  post: PostListItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [draftWhen, setDraftWhen] = useState<Date | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftMedia, setDraftMedia] = useState<DraftMedia[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const open = post != null;

  // Keyed on the post's identity, NOT the object. The `["posts"]` query hands
  // back a fresh object on every refetch — window focus, or the invalidation
  // this component fires after a media upload — and depending on `post` would
  // re-run this effect and wipe a caption the user was midway through typing.
  // Re-seeding is only correct when a different post is opened.
  const postId = post?.id ?? null;
  useEffect(() => {
    setDraftWhen(post?.scheduledAt ? new Date(post.scheduledAt) : null);
    setDraftText(post?.text ?? "");
    setDraftMedia(post ? toDraftMedia(post.mediaRefs) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  const uploadMedia = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return apiFetch<UploadedMedia>("/v1/media", {
        method: "POST",
        body: form,
      });
    },
    onSuccess: (m) => {
      setDraftMedia((prev) => [
        ...prev,
        {
          kind: m.contentType.startsWith("video") ? "video" : "image",
          url: m.url,
        },
      ]);
      qc.invalidateQueries({ queryKey: ["media"] });
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, "Upload failed"));
    },
  });

  const save = useMutation({
    mutationFn: (patch: PostPatch) => {
      if (!post) throw new Error("No post selected");
      return updatePost(post.id, patch);
    },
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["posts"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      // Preflight rejections arrive here with the platform's own rule text
      // ("Bluesky allows at most 4 images per post"), which is more useful
      // than anything this component could phrase itself.
      toast.error(errorMessage(err, "Save failed"));
    },
  });

  const cancel = useMutation({
    mutationFn: () => {
      if (!post) throw new Error("No post selected");
      return cancelPost(post.id);
    },
    onSuccess: () => {
      toast.success("Canceled");
      qc.invalidateQueries({ queryKey: ["posts"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, "Cancel failed"));
    },
  });

  const editable = post?.status === "queued";

  // Only send what actually moved: a PATCH carrying an unchanged caption would
  // emit a spurious post.updated webhook to every subscriber.
  const storedMedia = post ? toDraftMedia(post.mediaRefs) : [];
  const timeChanged =
    draftWhen != null &&
    draftWhen.toISOString() !== (post?.scheduledAt ?? null);
  const textChanged = post != null && draftText !== post.text;
  const mediaChanged = post != null && !sameMedia(draftMedia, storedMedia);
  const dirty = timeChanged || textChanged || mediaChanged;
  const textEmpty = draftText.trim().length === 0;

  function handleSave() {
    const patch: PostPatch = {};
    if (timeChanged && draftWhen) patch.scheduledAt = draftWhen.toISOString();
    if (textChanged) patch.text = draftText;
    if (mediaChanged) {
      patch.media = draftMedia.map((m) => ({
        kind: m.kind,
        // The API takes either source; send back whichever this ref carries.
        ...(m.url ? { url: m.url } : {}),
        ...(m.mediaId ? { mediaId: m.mediaId } : {}),
        ...(m.altText ? { altText: m.altText } : {}),
      })) as PostPatch["media"];
    }
    save.mutate(patch);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md flex flex-col p-0">
        <SheetHeader className="p-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Badge variant="outline" className="uppercase tracking-wide">
              {post?.platform}
            </Badge>
            <span className="text-sm font-normal capitalize">
              {post?.status}
            </span>
          </SheetTitle>
          <SheetDescription className="sr-only">
            {editable
              ? "Edit the caption, media, or scheduled time, or cancel the post."
              : "Inspect the post."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {post ? (
            <>
              <div className="space-y-2">
                <Label
                  htmlFor="post-caption"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Content
                </Label>
                {editable ? (
                  <textarea
                    id="post-caption"
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    className="min-h-32 w-full resize-y bg-muted/30 p-3 text-sm outline-none focus:bg-muted/40 transition-colors rounded-md ring-1 ring-foreground/10 focus:ring-foreground/20"
                  />
                ) : (
                  <p className="text-sm whitespace-pre-wrap mt-1">
                    {post.text}
                  </p>
                )}
              </div>

              <MediaStrip
                media={editable ? draftMedia : storedMedia}
                editable={!!editable}
                uploading={uploadMedia.isPending}
                onRemove={(i) =>
                  setDraftMedia((prev) => prev.filter((_, idx) => idx !== i))
                }
                onAdd={() => fileInputRef.current?.click()}
              />
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

              <Separator />

              {editable ? (
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    <Clock className="size-3" />
                    Scheduled for
                  </Label>
                  <DateTimePicker
                    value={draftWhen}
                    onChange={setDraftWhen}
                    minDate={new Date(Date.now() + 60_000)}
                  />
                </div>
              ) : (
                <PostedStatusLine post={post} />
              )}

              <Separator />

              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  {editable ? "Posting to" : "Posted to"}
                </Label>
                <AccountLine post={post} />
              </div>

              <div className="text-xs">
                <Link
                  href={`/logs/${post.id}`}
                  className="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
                >
                  Open full log
                  <ArrowSquareOut className="size-3" />
                </Link>
              </div>
            </>
          ) : null}
        </div>

        {editable ? (
          <div className="p-4 border-t flex items-center justify-between gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending || save.isPending}
            >
              <Trash className="size-3" />
              {cancel.isPending ? "Canceling…" : "Cancel"}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={
                !dirty || textEmpty || save.isPending || uploadMedia.isPending
              }
              title={
                textEmpty
                  ? "A post needs some text."
                  : !dirty
                    ? "Nothing changed yet."
                    : undefined
              }
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function MediaStrip({
  media,
  editable,
  uploading,
  onRemove,
  onAdd,
}: {
  media: DraftMedia[];
  editable: boolean;
  uploading: boolean;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  if (!editable && media.length === 0) return null;
  return (
    <div className="space-y-2">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        Media
      </Label>
      <div className="flex flex-wrap gap-1.5">
        {media.map((m, i) => (
          <div
            key={`${m.url ?? m.mediaId}-${i}`}
            className="size-12 rounded-md ring-1 ring-foreground/10 overflow-hidden relative group bg-muted/30"
          >
            {m.kind === "image" && m.url ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={m.url} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full grid place-items-center text-[9px] uppercase text-muted-foreground">
                {m.kind === "video" ? "VID" : "IMG"}
              </div>
            )}
            {editable ? (
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="absolute top-0.5 right-0.5 size-4 grid place-items-center bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Remove media"
              >
                <Trash className="size-2.5" />
              </button>
            ) : null}
          </div>
        ))}
        {editable && media.length < MAX_MEDIA_PER_POST ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={uploading}
            className="size-12 rounded-md ring-1 ring-dashed ring-foreground/20 hover:ring-foreground/40 transition-shadow grid place-items-center text-muted-foreground"
            aria-label="Add media"
          >
            {uploading ? (
              <span className="text-[9px]">…</span>
            ) : (
              <ImageIcon className="size-4" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.payload.message ?? fallback;
  if (err instanceof Error) return err.message;
  return fallback;
}

function PostedStatusLine({ post }: { post: PostListItem }) {
  // Pick the most informative timestamp: actual publish time beats the
  // schedule (since the row fired and we know exactly when), and the
  // canceled state has no time so falls through to scheduledAt.
  const showPublished = post.publishedAt;
  const showCanceled = post.status === "canceled";
  const showScheduled =
    !showPublished && post.scheduledAt && !showCanceled;
  return (
    <div className="space-y-1">
      <Label className="flex items-center gap-1.5">
        <Clock className="size-3" />
        {showPublished
          ? "Posted on"
          : showCanceled
            ? "Was scheduled for"
            : showScheduled
              ? "Scheduled for"
              : "Created"}
      </Label>
      <p className="text-sm tabular-nums">
        {formatStamp(
          post.publishedAt ?? post.scheduledAt ?? post.createdAt,
        )}
      </p>
      {showCanceled ? (
        <p className="text-xs text-muted-foreground">
          This post was canceled before it fired.
        </p>
      ) : showPublished ? null : (
        <p className="text-xs text-muted-foreground">
          This post has already fired and can't be changed.
        </p>
      )}
    </div>
  );
}

function AccountLine({ post }: { post: PostListItem }) {
  const brand = PLATFORM_BRANDS.find((b) => b.id === post.platform);
  const Icon = brand?.Icon;
  const handle = post.account.displayName ?? post.account.platformAccountId;
  return (
    <div className="flex items-center gap-2 mt-1">
      {Icon ? <Icon className="size-4 shrink-0" /> : null}
      <div className="min-w-0">
        <p className="text-sm font-semibold capitalize">
          {brand?.label ?? post.platform}
        </p>
        <p className="text-xs text-muted-foreground truncate">{handle}</p>
      </div>
    </div>
  );
}

function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
