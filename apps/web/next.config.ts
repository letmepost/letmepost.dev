import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      {
        source: "/_ph/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/_ph/:path+/",
        destination: "https://us.i.posthog.com/:path+/",
      },
      {
        source: "/_ph/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/docs",
        destination: "https://docs.letmepost.dev",
        permanent: true,
      },
      {
        source: "/docs/:path*",
        destination: "https://docs.letmepost.dev/:path*",
        permanent: true,
      },
      { source: "/tools", destination: "/", permanent: true },
      { source: "/tools/:path*", destination: "/", permanent: true },
      {
        source: "/sitemap-index.xml",
        destination: "/sitemap.xml",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
