"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/analytics";

/**
 * Silent recovery for sessions without an `activeOrganizationId`. The
 * happy-path sign-up sets one, but a stale `useSession` cache after redirect,
 * an interrupted sign-up, or a user removed from every org all land here.
 *
 * No UI: pick the first existing org if there is one, otherwise create one
 * named after the user, set it active, and bounce to /. The "Setting up…"
 * line only renders if we're still here after 250ms — fast paths flash
 * nothing.
 */
function deriveSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || `org-${Math.random().toString(36).slice(2, 8)}`
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const { data: orgs, isPending: orgsPending } =
    authClient.useListOrganizations();

  const [showSpinner, setShowSpinner] = useState(false);
  const ranRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setShowSpinner(true), 250);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (isPending || orgsPending) return;
    if (ranRef.current) return;

    if (!session) {
      router.replace("/sign-in");
      return;
    }

    const orgId = session.session?.activeOrganizationId;
    if (orgId) {
      router.replace("/");
      return;
    }

    ranRef.current = true;

    (async () => {
      try {
        if (orgs && orgs.length > 0) {
          await authClient.organization.setActive({
            organizationId: orgs[0].id,
          });
          router.replace("/");
          return;
        }
        // After email verification, users come here without an org. If we
        // captured their requested org name on the sign-up form, use it;
        // otherwise fall back to a name derived from their identity.
        let pendingName: string | null = null;
        if (typeof window !== "undefined") {
          const raw = window.localStorage.getItem("letmepost:pending-org");
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as { name?: string };
              if (parsed.name) pendingName = parsed.name;
            } catch {
              // ignore — fall through to fallback
            }
            window.localStorage.removeItem("letmepost:pending-org");
          }
        }
        const fallback =
          pendingName ||
          session.user?.name?.trim() ||
          session.user?.email?.split("@")[0] ||
          "My workspace";
        const { data, error } = await authClient.organization.create({
          name: fallback,
          slug: deriveSlug(fallback),
        });
        if (error || !data) {
          toast.error(error?.message ?? "Couldn't set up your workspace.");
          ranRef.current = false;
          return;
        }
        track({
          name: "org.created",
          properties: { is_first_org: true, org_id: data.id },
        });
        await authClient.organization.setActive({ organizationId: data.id });
        router.replace("/");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Setup failed.");
        ranRef.current = false;
      }
    })();
  }, [isPending, orgsPending, session, orgs, router]);

  return (
    <motion.div
      initial={{ opacity: 0, filter: "blur(6px)" }}
      animate={
        showSpinner
          ? { opacity: 1, filter: "blur(0px)" }
          : { opacity: 0, filter: "blur(6px)" }
      }
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="text-sm text-muted-foreground"
    >
      Setting up your workspace…
    </motion.div>
  );
}
