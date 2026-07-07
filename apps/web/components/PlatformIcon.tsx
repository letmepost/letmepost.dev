import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";

const phosphorName: Record<string, string> = {
  bluesky: "butterfly",
  linkedin: "linkedin-logo",
  x: "x-logo",
  twitter: "x-logo",
  instagram: "instagram-logo",
  facebook: "facebook-logo",
  threads: "threads-logo",
  youtube: "youtube-logo",
  tiktok: "tiktok-logo",
  pinterest: "pinterest-logo",
};

export function PlatformIcon({
  platform,
  size = 16,
  className,
}: {
  platform: string;
  size?: number;
  className?: string;
}) {
  const name = phosphorName[platform] ?? "circle";
  return (
    <Icon
      icon={`ph:${name}`}
      width={size}
      height={size}
      className={cn("shrink-0 text-mut transition-colors", className)}
    />
  );
}
