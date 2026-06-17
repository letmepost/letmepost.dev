"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ArrowRight } from "@phosphor-icons/react";
import {
  formatRelative,
  statusTone,
  type PostListItem,
} from "@/lib/posts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Operator-console table for the post log. Headless via TanStack Table; we
 * own the rendering with shadcn primitives so the brand reads consistently.
 *
 * Server already sorts (createdAt DESC, id DESC) and paginates by keyset
 * cursor — TanStack here is purely a column-rendering harness, no client-side
 * sort/filter. Click row → detail.
 */
export function PostsTable({ posts }: { posts: PostListItem[] }) {
  const router = useRouter();

  const columns = useMemo<ColumnDef<PostListItem>[]>(
    () => [
      {
        id: "when",
        header: "When",
        cell: ({ row }) => {
          const p = row.original;
          const ts = p.publishedAt ?? p.createdAt;
          return (
            <div className="flex flex-col leading-tight">
              <span className="text-sm text-foreground tabular-nums">
                {formatRelative(ts)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {new Date(ts).toLocaleString()}
              </span>
            </div>
          );
        },
        size: 130,
      },
      {
        id: "platform",
        header: "Platform",
        cell: ({ row }) => (
          <Badge variant="outline" className="uppercase tracking-wide">
            {row.original.platform}
          </Badge>
        ),
        size: 100,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge variant={statusTone(row.original.status)}>
            {row.original.status}
          </Badge>
        ),
        size: 110,
      },
      {
        id: "account",
        header: "Account",
        cell: ({ row }) => {
          const a = row.original.account;
          return (
            <span
              className="text-sm text-foreground/90 truncate block max-w-[180px]"
              title={a.platformAccountId}
            >
              {a.displayName ?? a.platformAccountId}
            </span>
          );
        },
        size: 200,
      },
      {
        id: "text",
        header: "Text",
        cell: ({ row }) => (
          <span
            className="text-sm text-foreground/90 truncate block max-w-[60ch]"
            title={row.original.text}
          >
            {row.original.text}
          </span>
        ),
      },
      {
        id: "error",
        header: "Error",
        cell: ({ row }) => {
          const code = row.original.error?.code;
          return code ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              {code}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          );
        },
        size: 180,
      },
      {
        id: "chevron",
        header: "",
        cell: () => (
          <ArrowRight className="size-4 text-muted-foreground" />
        ),
        size: 40,
      },
    ],
    [],
  );

  const table = useReactTable({
    data: posts,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="rounded-md ring-1 ring-foreground/10 bg-card">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((h) => (
                <TableHead
                  key={h.id}
                  style={
                    h.getSize() !== 150
                      ? { width: h.getSize() }
                      : undefined
                  }
                >
                  {h.isPlaceholder
                    ? null
                    : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn("cursor-pointer")}
              onClick={() => router.push(`/logs/${row.original.id}`)}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
