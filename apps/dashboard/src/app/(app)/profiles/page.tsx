"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { ApiRequestError } from "@/lib/api";
import {
  createProfile,
  deleteProfile,
  listProfiles,
  renameProfile,
  slugify,
  type Profile,
} from "@/lib/profiles";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { FadeIn, StaggerList, StaggerItem } from "@/components/app/motion";

/**
 * Profiles CRUD. Profiles are the agency-style "client workspace" sub-unit
 * inside an organization — every account, post, key can be scoped to one.
 *
 * Delete refuses with 409 when accounts still attach to the profile; the API
 * returns a structured error and we surface it inline (toast + ConfirmDialog
 * stays open with the error visible).
 */
export default function ProfilesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Profile | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Profile | null>(null);

  const query = useQuery({
    queryKey: queryKeys.profiles.list(),
    queryFn: () => listProfiles().then((r) => r.data ?? []),
  });
  const profiles = query.data ?? null;
  const error = query.error
    ? query.error instanceof ApiRequestError
      ? query.error.payload.message
      : query.error instanceof Error
        ? query.error.message
        : "Failed to load."
    : null;

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProfile(id),
    onSuccess: () => {
      toast.success("Profile deleted.");
      queryClient.invalidateQueries({ queryKey: queryKeys.profiles.list() });
    },
    onError: (err: unknown) => {
      // Surface the API's 409 not-empty rule via toast; the ConfirmDialog
      // re-throws so it stays open and the user can back out manually.
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Delete failed.",
      );
    },
  });

  return (
    <div className="space-y-6">
      <FadeIn className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Profiles</h1>
          <p className="text-xs text-muted-foreground">
            Sub-workspaces inside this org. Group platform accounts by client
            or brand. API keys and posts can scope to any one of them.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New profile
        </Button>
      </FadeIn>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load profiles</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : profiles === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : profiles.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No profiles yet</CardTitle>
            <CardDescription>
              Every org gets a "Default" profile on creation. If you've removed
              it, create one to keep posting.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Create profile
            </Button>
          </CardContent>
        </Card>
      ) : (
        <StaggerList className="space-y-2">
          {profiles.map((p) => (
            <StaggerItem key={p.id}>
              <Card size="sm">
                <CardContent className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {p.name}
                      </span>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {p.slug}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Created {new Date(p.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRenameTarget(p)}
                  >
                    <PencilSimple className="size-4" />
                    Rename
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(p)}
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

      <CreateProfileDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <RenameProfileDialog
        target={renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this profile?"
        description={
          pendingDelete ? (
            <>
              <span className="font-medium text-foreground">
                {pendingDelete.name}
              </span>{" "}
              will be removed. The API will refuse if any platform accounts
              still attach to it. Disconnect or move them first.
            </>
          ) : null
        }
        confirmLabel="Delete profile"
        variant="destructive"
        onConfirm={async () => {
          if (pendingDelete) await deleteMutation.mutateAsync(pendingDelete.id);
        }}
      />
    </div>
  );
}

function CreateProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const slug = useMemo(() => slugify(name), [name]);

  function reset() {
    setName("");
  }

  const mutation = useMutation({
    mutationFn: () => createProfile({ name, slug }),
    onSuccess: (data) => {
      toast.success(`Created "${data.name}".`);
      queryClient.invalidateQueries({ queryKey: queryKeys.profiles.list() });
      onOpenChange(false);
      reset();
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
  const submitting = mutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New profile</DialogTitle>
            <DialogDescription>
              Profiles group platform accounts. Use them per-client or
              per-brand. API keys and posts can scope to any one of them.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-profile-name">Name</Label>
              <Input
                id="new-profile-name"
                required
                placeholder="Acme Coffee"
                className="h-9"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              {name.trim().length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  slug:{" "}
                  <span className="font-mono text-foreground/80">{slug}</span>
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || name.trim().length === 0}
            >
              {submitting ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameProfileDialog({
  target,
  onOpenChange,
}: {
  target: Profile | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  useEffect(() => {
    setName(target?.name ?? "");
  }, [target]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("No target");
      return renameProfile(target.id, { name });
    },
    onSuccess: () => {
      toast.success("Profile renamed.");
      queryClient.invalidateQueries({ queryKey: queryKeys.profiles.list() });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Rename failed.",
      );
    },
  });
  const submitting = mutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    mutation.mutate();
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename profile</DialogTitle>
            <DialogDescription>
              The slug stays put. Rename is name-only here. To change the
              slug, edit it via the API.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="rename-profile-name">Name</Label>
              <Input
                id="rename-profile-name"
                required
                className="h-9"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                submitting ||
                name.trim().length === 0 ||
                name.trim() === target?.name
              }
            >
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
