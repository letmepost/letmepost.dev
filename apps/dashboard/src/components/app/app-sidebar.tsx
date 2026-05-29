"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  House,
  Plug,
  Key,
  Broadcast,
  ListBullets,
  Folders,
  ImageSquare,
  CaretUpDown,
  Check,
  Plus,
  BookOpen,
  ArrowSquareOut,
  CreditCard,
  SignOut,
  PaperPlaneTilt,
  CalendarBlank,
  ChartLine,
  Gear,
  SquaresFour,
  Scroll as ScrollIcon,
} from "@phosphor-icons/react";

import { authClient } from "@/lib/auth-client";
import { track } from "@/lib/analytics";
import { NewOrgDialog } from "@/components/app/new-org-dialog";
import { LogoMark } from "@/components/app/logo";
import { SidebarUsageMeter } from "@/components/app/sidebar-usage-meter";
import { useActiveProfile } from "@/lib/profiles";
import { useSubscription } from "@/lib/billing";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Three groups in priority order:
//   - Operate: the daily flow (compose → schedule → publish → audit)
//   - Setup: things you connect once and reuse (orgs, accounts, media)
//   - Developer: API surface (keys, webhooks)
// Settings lives in the footer alongside Docs + Billing.
//
// Posts is a parent item with three sub-pages (Grid / List / Calendar);
// clicking the parent navigates to /posts (= grid view). The children
// auto-expand whenever the active route is under /posts/*.
const NAV_GROUPS = [
  {
    label: "Operate",
    items: [
      { href: "/", label: "Dashboard", icon: House },
      {
        href: "/posts",
        label: "Posts",
        icon: PaperPlaneTilt,
        children: [
          { href: "/posts", label: "Grid", icon: SquaresFour },
          { href: "/posts/list", label: "List", icon: ListBullets },
          { href: "/posts/calendar", label: "Calendar", icon: CalendarBlank },
        ],
      },
      { href: "/logs", label: "Logs", icon: ScrollIcon },
      { href: "/analytics", label: "Analytics", icon: ChartLine },
    ],
  },
  {
    label: "Setup",
    items: [
      { href: "/accounts", label: "Accounts", icon: Plug },
      { href: "/profiles", label: "Profiles", icon: Folders },
      { href: "/media", label: "Media", icon: ImageSquare },
    ],
  },
  {
    label: "Developer",
    items: [
      { href: "/api-keys", label: "API keys", icon: Key },
      { href: "/webhooks", label: "Webhooks", icon: Broadcast },
    ],
  },
] as const;

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const { data: organizations } = authClient.useListOrganizations();
  const activeOrg = authClient.useActiveOrganization().data;
  const [newOrgOpen, setNewOrgOpen] = useState(false);
  const {
    profiles,
    activeProfile,
    setActiveProfile,
    isLoading: profilesLoading,
  } = useActiveProfile();
  const subscription = useSubscription();
  const isSelfHost = subscription.data?.tier === "self_host";

  async function switchOrg(id: string) {
    try {
      const fromOrgId = activeOrg?.id ?? null;
      await authClient.organization.setActive({ organizationId: id });
      track({
        name: "org.switched",
        properties: { from_org_id: fromOrgId, to_org_id: id },
      });
      // Force a refresh so server components / API calls pick up the new active org.
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to switch organization.",
      );
    }
  }

  async function handleSignOut() {
    await authClient.signOut();
    track({ name: "signout.completed", properties: {} });
    router.push("/sign-in");
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent"
            >
              <LogoMark size={28} />

              <div className="flex flex-col leading-none text-left min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <span className="text-sm font-semibold truncate">
                  {activeOrg?.name ?? "No organization"}
                </span>
                <span className="text-xs text-muted-foreground truncate">
                  letmepost.dev
                </span>
              </div>
              <CaretUpDown className="ml-auto size-4 shrink-0 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
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
            <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
              Organizations
            </DropdownMenuLabel>
            {organizations?.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onSelect={() => switchOrg(org.id)}
              >
                <span className="truncate flex-1">{org.name}</span>
                {activeOrg?.id === org.id ? (
                  <Check className="size-4 text-muted-foreground" />
                ) : null}
              </DropdownMenuItem>
            ))}
            {organizations == null || organizations.length === 0 ? (
              <DropdownMenuItem disabled>No organizations yet</DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setNewOrgOpen(true);
              }}
            >
              <Plus className="size-4" />
              <span>New organization</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleSignOut}>
              <SignOut className="size-4" />
              <span>Sign out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Working in</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton
                      className="data-[state=open]:bg-sidebar-accent"
                      disabled={profilesLoading || profiles.length === 0}
                    >
                      <Folders className="size-4" />
                      <span className="truncate flex-1 text-left">
                        {profilesLoading
                          ? "Loading…"
                          : activeProfile?.name ?? "No profile"}
                      </span>
                      {profiles.length > 1 ? (
                        <CaretUpDown className="ml-auto size-4 shrink-0" />
                      ) : null}
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel>Profiles</DropdownMenuLabel>
                    {profiles.map((p) => (
                      <DropdownMenuItem
                        key={p.id}
                        onSelect={() => setActiveProfile(p.id)}
                      >
                        <span className="truncate flex-1">{p.name}</span>
                        {activeProfile?.id === p.id ? (
                          <Check className="size-4 text-muted-foreground" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => router.push("/profiles")}>
                      <Plus className="size-4" />
                      <span>Manage profiles</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Primary CTA — Create post — pinned above the section nav so
            it's the first thing your eye hits. Lives in the sidebar
            (not the page header) so it's reachable from anywhere. */}
        <SidebarGroup className="group-data-[collapsible=icon]:px-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground font-semibold"
                >
                  <Link href="/posts/new">
                    <Plus className="size-4" />
                    <span>Create post</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname === item.href ||
                        pathname.startsWith(`${item.href}/`);
                  const hasChildren =
                    "children" in item && item.children !== undefined;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={active}>
                        <Link href={item.href}>
                          <Icon className="size-4" />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {hasChildren && active ? (
                        <SidebarMenuSub>
                          {item.children!.map((child) => {
                            const ChildIcon = child.icon;
                            const childActive = pathname === child.href;
                            return (
                              <SidebarMenuSubItem key={child.href}>
                                <SidebarMenuSubButton
                                  asChild
                                  isActive={childActive}
                                >
                                  <Link href={child.href}>
                                    <ChildIcon className="size-3.5" />
                                    <span>{child.label}</span>
                                  </Link>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            );
                          })}
                        </SidebarMenuSub>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

      </SidebarContent>

      <SidebarFooter className="gap-1 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a
                href="https://docs.letmepost.dev"
                target="_blank"
                rel="noopener noreferrer"
              >
                <BookOpen className="size-4" />
                <span>Docs</span>
                <ArrowSquareOut className="size-3 ml-auto opacity-60" />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {!isSelfHost ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={
                  pathname === "/billing" || pathname.startsWith("/billing/")
                }
              >
                <Link href="/billing">
                  <CreditCard className="size-4" />
                  <span>Billing</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={
                pathname === "/settings" || pathname.startsWith("/settings/")
              }
            >
              <Link href="/settings">
                <Gear className="size-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarUsageMeter />
      </SidebarFooter>

      <NewOrgDialog open={newOrgOpen} onOpenChange={setNewOrgOpen} />
    </Sidebar>
  );
}
