import type { Metadata } from "next";

// Static title for post detail. The page itself doesn't have access to
// metadata exports (it's a client component), and the post id changes
// per route — using `generateMetadata` to fetch the post just to title
// the tab is more round-trips than it's worth. "Post" + the id in the
// breadcrumb is enough disambiguation.
export const metadata: Metadata = {
  title: "Post",
};

export default function PostDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
