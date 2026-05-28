"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { CONNECTABLE_PLATFORMS, type ConnectablePlatform } from "@/lib/accounts";

function asAnalyticsPlatform(
  value: string | null,
): ConnectablePlatform | null {
  if (!value) return null;
  return (CONNECTABLE_PLATFORMS as readonly string[]).includes(value)
    ? (value as ConnectablePlatform)
    : null;
}

/**
 * Surface OAuth-callback toasts on whatever page the user lands on via
 * the connect flow's `returnTo`. Reads `?connected=` or
 * `?connect_error=` from the URL, fires the right toast + analytics
 * event, invalidates the accounts cache, and strips the query so a
 * page reload doesn't re-fire.
 *
 * Mount this on every "landable" surface (dashboard home, accounts page,
 * any custom returnTo target). It's a no-op when the params aren't
 * present.
 */
export function useConnectCallback() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("connect_error");
    const platform = searchParams.get("platform");
    if (!connected && !error) return;

    if (connected) {
      const p = asAnalyticsPlatform(connected);
      if (p) {
        track({
          name: "connect.oauth_returned",
          properties: { platform: p, outcome: "success" },
        });
      }
      toast.success(`Connected ${connected}.`);
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    } else if (error) {
      const rule = searchParams.get("connect_rule");
      const message = searchParams.get("connect_message");
      const remediation = searchParams.get("connect_remediation");
      const p = asAnalyticsPlatform(platform);
      if (p) {
        track({
          name: "connect.oauth_returned",
          properties: {
            platform: p,
            outcome: error === "user_denied" ? "denied" : "error",
            error_code: error,
          },
        });
      }
      if (message) {
        toast.error(message, {
          description: remediation ?? undefined,
          duration: Infinity,
          closeButton: true,
        });
      } else {
        toast.error(
          platform
            ? `${platform} connect failed: ${error.replaceAll("_", " ")}`
            : `Connect failed: ${error.replaceAll("_", " ")}`,
        );
      }
    }
    // Strip the params without scrolling. Stay on the same path so the
    // user keeps the context they had when the connect started.
    router.replace(pathname, { scroll: false });
  }, [searchParams, router, pathname, queryClient]);
}
