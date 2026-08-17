"use client";

import { useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { authClient, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

/**
 * Persistent warning shown while an admin is impersonating a user. Rendered for
 * the whole authed surface, so there is no route inside the dashboard where the
 * operator can forget whose account they are looking at.
 *
 * `impersonatedBy` is set server-side by the admin impersonation plugin and is
 * declared `input: false`, so a client cannot fake or clear it.
 */
export function ImpersonationBanner() {
  const { data } = useSession();
  const [exiting, setExiting] = useState(false);

  const impersonatedBy = (
    data?.session as { impersonatedBy?: string | null } | undefined
  )?.impersonatedBy;
  if (!impersonatedBy) return null;

  async function exit() {
    setExiting(true);
    // The session row *is* the impersonation, so revoking it is the whole exit.
    await authClient.signOut();
    window.location.href = "/sign-in";
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <Warning className="size-4 shrink-0" />
      <span>
        Viewing as <strong>{data?.user?.email ?? "this user"}</strong> — admin
        impersonation by <strong>{impersonatedBy}</strong>. Anything you do is
        recorded against their account.
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={exit}
        disabled={exiting}
        className="ml-auto h-7"
      >
        {exiting ? "Exiting…" : "Exit"}
      </Button>
    </div>
  );
}
