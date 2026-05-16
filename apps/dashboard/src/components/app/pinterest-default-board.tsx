"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "@phosphor-icons/react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Board = { id: string; name: string; privacy: string | null };
type BoardsResponse = {
  data: Board[];
  defaultBoardId: string | null;
};
type CreateBoardResponse = {
  id: string;
  name: string;
  defaultBoardId?: string;
  defaultBoardName?: string;
};

type Privacy = "PUBLIC" | "PROTECTED" | "SECRET";

/**
 * Small select on the Pinterest account card. Lists the user's boards
 * (fetched live from Pinterest via the API proxy) and PATCHes our backend
 * when the selection changes. Includes a "Create board" affordance so a
 * boardless connect — common on fresh Pinterest accounts — isn't a
 * dead-end.
 */
export function PinterestDefaultBoard({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.accounts.pinterestBoards(accountId),
    queryFn: () =>
      apiFetch<BoardsResponse>(`/v1/accounts/${accountId}/pinterest/boards`),
    staleTime: 5 * 60 * 1000,
  });

  const setDefault = useMutation({
    mutationFn: (boardId: string) =>
      apiFetch<{ defaultBoardId: string; defaultBoardName: string }>(
        `/v1/accounts/${accountId}/pinterest/default-board`,
        {
          method: "PATCH",
          body: JSON.stringify({ boardId }),
        },
      ),
    onSuccess: (data) => {
      track({
        name: "pinterest.default_board_set",
        properties: {
          board_count: queryClient
            .getQueryData<BoardsResponse>(queryKeys.accounts.pinterestBoards(accountId))
            ?.data.length ?? 0,
        },
      });
      toast.success(`Default board: ${data.defaultBoardName}`);
      queryClient.invalidateQueries({
        queryKey: queryKeys.accounts.pinterestBoards(accountId),
      });
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Failed to update default board.",
      );
    },
  });

  if (query.isLoading) {
    return (
      <div className="text-[11px] text-muted-foreground">
        Loading boards…
      </div>
    );
  }
  if (query.error) {
    return (
      <div className="text-[11px] text-destructive">
        Couldn&apos;t load boards.
      </div>
    );
  }
  const boards = query.data?.data ?? [];
  const currentId = query.data?.defaultBoardId ?? undefined;

  return (
    <div className="space-y-1.5">
      {boards.length === 0 ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            No boards on this account yet.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            Create board
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground shrink-0">
            Default board
          </span>
          <Select
            value={currentId}
            onValueChange={(v) => setDefault.mutate(v)}
            disabled={setDefault.isPending}
          >
            <SelectTrigger size="sm" className="h-7 text-xs flex-1 min-w-0">
              <SelectValue placeholder="Pick a board" />
            </SelectTrigger>
            <SelectContent>
              {boards.map((b) => (
                <SelectItem key={b.id} value={b.id} className="text-xs">
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => setCreateOpen(true)}
            title="Create a new board on Pinterest"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      )}

      <CreateBoardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accountId={accountId}
        // First board on the account becomes the default automatically;
        // subsequent ones don't (the user already has a default they may
        // care about preserving).
        autoSetAsDefault={boards.length === 0}
      />
    </div>
  );
}

function CreateBoardDialog({
  open,
  onOpenChange,
  accountId,
  autoSetAsDefault,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  autoSetAsDefault: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [privacy, setPrivacy] = useState<Privacy>("PUBLIC");

  const create = useMutation({
    mutationFn: () =>
      apiFetch<CreateBoardResponse>(
        `/v1/accounts/${accountId}/pinterest/boards`,
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            privacy,
            setAsDefault: autoSetAsDefault,
          }),
        },
      ),
    onSuccess: (created) => {
      toast.success(`Created board: ${created.name}`);
      queryClient.invalidateQueries({
        queryKey: queryKeys.accounts.pinterestBoards(accountId),
      });
      onOpenChange(false);
      setName("");
      setPrivacy("PUBLIC");
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Failed to create board.",
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a Pinterest board</DialogTitle>
          <DialogDescription>
            Boards group pins on Pinterest. New boards default to public so
            anyone with the link can see them.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || create.isPending) return;
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="board-name">Name</Label>
            <Input
              id="board-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Product launches"
              maxLength={180}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="board-privacy">Privacy</Label>
            <Select
              value={privacy}
              onValueChange={(v) => setPrivacy(v as Privacy)}
            >
              <SelectTrigger id="board-privacy" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PUBLIC">
                  Public, anyone can see this board
                </SelectItem>
                <SelectItem value="PROTECTED">
                  Protected, only you and collaborators
                </SelectItem>
                <SelectItem value="SECRET">
                  Secret, only you
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create board"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
