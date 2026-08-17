import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/Providers";
import { ClarityHeader } from "@/components/ClarityHeader";
import { ClarityFooter } from "@/components/ClarityFooter";
import { JsonLd } from "@/components/JsonLd";
import { PageTransition } from "@/components/PageTransition";

const SITE = "https://letmepost.dev";
const DEFAULT_DESCRIPTION =
  "Open-source social media publishing API for developers and AI agents. Preflight validation, transparent errors, stable versions, idempotency by default.";
const OG_ALT = "letmepost.dev. Social media publishing that fails loudly.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: "letmepost.dev", template: "%s · letmepost.dev" },
  description: DEFAULT_DESCRIPTION,
  applicationName: "letmepost.dev",
  alternates: {
    canonical: "/",
    types: { "application/rss+xml": `${SITE}/rss.xml` },
  },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  // Only needed for Search Console's HTML-tag verification. A DNS-verified
  // Domain property covers letmepost.dev and every subdomain at once and
  // needs nothing here — leave the var unset in that case.
  ...(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
    ? {
        verification: {
          google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
        },
      }
    : {}),
  openGraph: {
    type: "website",
    siteName: "letmepost.dev",
    locale: "en_US",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        type: "image/png",
        alt: OG_ALT,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@letmepostdotdev",
    creator: "@letmepostdotdev",
    images: [{ url: "/og-image.png", alt: OG_ALT }],
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf6" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0f0c" },
  ],
};

const DEFAULT_GRAPHS: Record<string, unknown>[] = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE}/#organization`,
    name: "letmepost.dev",
    url: SITE,
    logo: `${SITE}/og-image.png`,
    description:
      "Open-source social media publishing API for developers and AI agents.",
    sameAs: [
      "https://github.com/rosekamallove/letmepost.dev",
      "https://x.com/letmepostdotdev",
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE}/#website`,
    name: "letmepost.dev",
    url: SITE,
    publisher: { "@id": `${SITE}/#organization` },
  },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <JsonLd graphs={DEFAULT_GRAPHS} />
        <Providers>
          <ClarityHeader />
          <main>
            <PageTransition>{children}</PageTransition>
          </main>
          <ClarityFooter />
        </Providers>
      </body>
    </html>
  );
}
