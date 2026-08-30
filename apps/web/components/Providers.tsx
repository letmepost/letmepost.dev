"use client";

import { ThemeProvider } from "next-themes";
import { Analytics } from "@vercel/analytics/next";
import { PageviewTracker } from "./providers/pageview-tracker";
import { AnalyticsClicks } from "./providers/analytics-clicks";
import { Attribution } from "./providers/attribution";
import { GoogleAnalytics } from "./providers/google-analytics";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
      <PageviewTracker />
      <AnalyticsClicks />
      <Attribution />
      <Analytics />
      <GoogleAnalytics />
    </ThemeProvider>
  );
}
