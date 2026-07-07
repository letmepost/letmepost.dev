import Link from "next/link";

export function ClarityBrand({ size = 22 }: { size?: number }) {
  return (
    <Link
      href="/"
      className="flex items-center gap-[10px] text-[17px] font-bold tracking-[-0.01em] text-ink"
      aria-label="letmepost.dev"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="16" cy="16" r="15" fill="var(--color-acc)" />
        <rect
          x="9.5"
          y="9.5"
          width="13"
          height="13"
          fill="var(--color-bg)"
          transform="rotate(16 16 16)"
        />
      </svg>
      letmepost
    </Link>
  );
}
