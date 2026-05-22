import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Upgrade plan",
};

export default function UpgradeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
