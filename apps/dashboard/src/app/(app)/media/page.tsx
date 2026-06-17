"use client";

import { useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, ImageSquare, UploadSimple } from "@phosphor-icons/react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn, StaggerList, StaggerItem } from "@/components/app/motion";

type MediaRow = {
  id: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  profileId: string;
  createdAt: string;
};

type ListResponse = {
  data: MediaRow[];
  nextCursor: string | null;
};

type CreateMediaResponse = {
  id: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export default function MediaListPage() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.media.list(),
    queryFn: () => apiFetch<ListResponse>("/v1/media?limit=50"),
  });
  const items = query.data?.data ?? null;
  const error = query.error
    ? query.error instanceof ApiRequestError
      ? query.error.payload.message
      : query.error instanceof Error
        ? query.error.message
        : "Failed to load."
    : null;

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file, file.name);
      return apiFetch<CreateMediaResponse>("/v1/media", {
        method: "POST",
        body: form,
      });
    },
    onSuccess: (created) => {
      toast.success(`Uploaded ${created.id}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof ApiRequestError
          ? err.payload.message
          : err instanceof Error
            ? err.message
            : "Upload failed.",
      );
    },
  });

  function pickFile() {
    fileInputRef.current?.click();
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    // MVP: one file at a time. Multi-upload lands when the publishers can
    // actually consume multi-image / carousel — see Phase 7.5 + Phase 11.
    const first = files[0];
    if (first) upload.mutate(first);
  }

  return (
    <div className="space-y-6">
      <FadeIn className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Media</h1>
          <p className="text-xs text-muted-foreground">
            Upload images and videos once, reference them by id from any post.
          </p>
        </div>
        <Button onClick={pickFile} disabled={upload.isPending}>
          <UploadSimple className="size-4" />
          {upload.isPending ? "Uploading…" : "Upload"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </FadeIn>

      <FadeIn>
        <button
          type="button"
          onClick={pickFile}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`w-full rounded-md border-2 border-dashed px-6 py-10 text-left transition-colors ${
            dragActive
              ? "border-foreground bg-muted"
              : "border-input hover:border-muted-foreground"
          }`}
          disabled={upload.isPending}
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <ImageSquare className="size-6 text-muted-foreground" />
            <div className="text-sm">
              {upload.isPending
                ? "Uploading…"
                : "Drop a file here, or click to browse"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Images (jpg / png / webp / gif) and video (mp4 / mov / webm). Up
              to 200 MB.
            </div>
          </div>
        </button>
      </FadeIn>

      {error ? (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load media</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : items === null ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No media yet</CardTitle>
            <CardDescription>
              Upload a file to start referencing it from posts as{" "}
              <code className="font-mono text-[11px]">
                {`media: [{ kind, mediaId }]`}
              </code>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <StaggerList className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <StaggerItem key={item.id}>
              <MediaCard item={item} />
            </StaggerItem>
          ))}
        </StaggerList>
      )}
    </div>
  );
}

function MediaCard({ item }: { item: MediaRow }) {
  const isImage = item.contentType.startsWith("image/");
  const isVideo = item.contentType.startsWith("video/");

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono uppercase tracking-wide">
            {item.contentType}
          </span>
          <span>{formatBytes(item.sizeBytes)}</span>
        </div>
        <CardTitle className="font-mono text-xs break-all">
          {item.id}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="aspect-video w-full bg-muted overflow-hidden flex items-center justify-center">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.url}
              alt=""
              className="max-h-full max-w-full object-contain"
              loading="lazy"
            />
          ) : isVideo ? (
            <video
              src={item.url}
              className="max-h-full max-w-full"
              controls={false}
              muted
              playsInline
              preload="metadata"
            />
          ) : (
            <div className="text-xs text-muted-foreground">
              No preview
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <CopyButton label="Copy id" value={item.id} />
          <CopyButton label="Copy URL" value={item.url} />
        </div>
        <div className="text-[11px] text-muted-foreground">
          Uploaded {new Date(item.createdAt).toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(`${label.replace(/^Copy /, "")} copied.`);
        } catch {
          toast.error("Clipboard access denied.");
        }
      }}
    >
      <Copy className="size-3.5" />
      {label}
    </Button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
