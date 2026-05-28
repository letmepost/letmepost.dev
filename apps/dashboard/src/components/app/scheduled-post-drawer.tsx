"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash, ArrowSquareOut, Clock } from "@phosphor-icons/react";
import {
  cancelPost,
  reschedulePost,
  type PostListItem,
} from "@/lib/posts";
import { ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

/**
 * Drawer for inspecting and mutating a single scheduled post. Driven by an
 * optional `post` prop; rendered open whenever a post is provided. Used from
 * both /calendar (click chip on day cell) and /posts (compose surface).
 *
 * Reschedule + cancel call the new PATCH/DELETE endpoints and invalidate the
 * posts query so every surface re-renders consistently.
 */
export function ScheduledPostDrawer({
  post,
  onOpenChange,
}: {
  post: PostListItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [draftWhen, setDraftWhen] = useState("");
  const open = post != null;

  useEffect(() => {
    if (!post?.scheduledAt) {
      setDraftWhen("");
      return;
    }
    // datetime-local wants a value WITHOUT the timezone suffix in the user's
    // local time. Build it manually from the parsed Date so the UI shows the
    // same wall-clock time the user originally picked.
    const d = new Date(post.scheduledAt);
    const pad = (n: number) => n.toString().padStart(2, "0");
    setDraftWhen(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
  }, [post]);

  const reschedule = useMutation({
    mutationFn: (when: string) => {
      if (!post) throw new Error("No post selected");
      return reschedulePost(post.id, new Date(when).toISOString());
    },
    onSuccess: () => {
      toast.success("Rescheduled");
      qc.invalidateQueries({ queryKey: ["posts"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiRequestError
          ? err.payload.message ?? "Reschedule failed"
          : err instanceof Error
            ? err.message
            : "Reschedule failed";
      toast.error(msg);
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
      const msg =
        err instanceof ApiRequestError
          ? err.payload.message ?? "Cancel failed"
          : err instanceof Error
            ? err.message
            : "Cancel failed";
      toast.error(msg);
    },
  });

  const editable = post?.status === "queued";

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
            Reschedule or cancel the scheduled post.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {post ? (
            <>
              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Content
                </Label>
                <p className="text-sm whitespace-pre-wrap mt-1">{post.text}</p>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label htmlFor="when" className="flex items-center gap-1.5">
                  <Clock className="size-3" />
                  Scheduled for
                </Label>
                <Input
                  id="when"
                  type="datetime-local"
                  value={draftWhen}
                  onChange={(e) => setDraftWhen(e.target.value)}
                  disabled={!editable}
                />
                {!editable ? (
                  <p className="text-xs text-muted-foreground">
                    {post.status === "canceled"
                      ? "This post was canceled."
                      : "This post has already fired and can't be changed."}
                  </p>
                ) : null}
              </div>

              <Separator />

              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Posting to
                </Label>
                <p className="text-sm mt-1">
                  {post.account.displayName ?? post.account.platformAccountId}
                </p>
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
              disabled={cancel.isPending}
            >
              <Trash className="size-3" />
              {cancel.isPending ? "Canceling…" : "Cancel"}
            </Button>
            <Button
              size="sm"
              onClick={() => draftWhen && reschedule.mutate(draftWhen)}
              disabled={reschedule.isPending || !draftWhen}
            >
              {reschedule.isPending ? "Saving…" : "Reschedule"}
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
