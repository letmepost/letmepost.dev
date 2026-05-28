import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Logs",
};

export default function PostsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
