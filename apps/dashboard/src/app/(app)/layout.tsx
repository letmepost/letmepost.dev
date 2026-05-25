import type { Metadata } from "next";
import { AppSidebar } from "@/components/app/app-sidebar";
import { AuthGuard } from "@/components/app/auth-guard";
import { Breadcrumbs } from "@/components/app/breadcrumbs";
import { PageTransition } from "@/components/app/motion";
import { ThemeToggle } from "@/components/app/theme-toggle";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ProfileProvider } from "@/lib/profiles";

/**
 * Default title for any route under `(app)` that doesn't override via its
 * own `layout.tsx`. The home route at `/` inherits this — every other
 * route has a sibling `layout.tsx` that swaps in the route-specific title.
 *
 * The root layout's template is `%s · letmepost.dev`, so the rendered
 * `<title>` becomes `Dashboard · letmepost.dev` etc.
 */
export const metadata: Metadata = {
  title: "Dashboard",
};

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      {/*
        ProfileProvider must wrap the entire authed surface so the sidebar
        switcher and every page share the same `activeProfileId`. Mounting
        it here (instead of inside each page) is what makes profile
        switching actually propagate.
      */}
      <ProfileProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <header className="flex h-12 items-center gap-2 border-b px-4">
              <SidebarTrigger />
              <Breadcrumbs />
              <div className="ml-auto">
                <ThemeToggle />
              </div>
            </header>
            <div className="flex-1 p-6 md:p-8 [&>*]:max-w-5xl [&:has([data-page-wide])>*]:max-w-none">
              <PageTransition>{children}</PageTransition>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </ProfileProvider>
    </AuthGuard>
  );
}
