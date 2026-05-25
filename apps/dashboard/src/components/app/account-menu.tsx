"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  CreditCard,
  Monitor,
  Moon,
  SignOut,
  Sun,
} from "@phosphor-icons/react";

import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/analytics";
import { useSubscription } from "@/lib/billing";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Compact account dropdown for the top-right of the page header. Holds the
// non-navigation admin items (billing, theme, sign out) that used to live
// in the sidebar footer.
export function AccountMenu() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const subscription = useSubscription();
  const isSelfHost = subscription.data?.tier === "self_host";

  const initials = (session?.user.name ?? session?.user.email ?? "?")
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2) || "?";

  async function handleSignOut() {
    await authClient.signOut();
    track({ name: "signout.completed", properties: {} });
    router.push("/sign-in");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-1.5 gap-2 data-[state=open]:bg-accent"
        >
          <Avatar className="size-6">
            <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold truncate">
            {session?.user.name ?? session?.user.email ?? "Account"}
          </span>
          {session?.user.name && session?.user.email ? (
            <span className="text-xs text-muted-foreground truncate font-normal">
              {session.user.email}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!isSelfHost ? (
          <>
            <DropdownMenuItem asChild>
              <Link href="/billing">
                <CreditCard className="size-4" />
                <span>Billing</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Theme
        </DropdownMenuLabel>
        <ThemeRadioGroup />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleSignOut}>
          <SignOut className="size-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeRadioGroup() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Inert placeholder until next-themes reads localStorage, matched to the
  // row height so the dropdown doesn't shift on hydrate.
  if (!mounted) {
    return <div aria-hidden className="h-[84px]" />;
  }
  return (
    <DropdownMenuRadioGroup
      value={theme ?? "system"}
      onValueChange={(next) => {
        track({
          name: "theme.changed",
          properties: { from: theme ?? "system", to: next },
        });
        setTheme(next);
      }}
    >
      <DropdownMenuRadioItem value="light">
        <Sun className="size-4" />
        <span>Light</span>
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark">
        <Moon className="size-4" />
        <span>Dark</span>
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="system">
        <Monitor className="size-4" />
        <span>System</span>
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}
