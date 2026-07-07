import Link from "next/link";
import { PLATFORMS } from "@/data/platforms";
import { ClarityBrand } from "./ClarityBrand";
import { GitHubStars } from "./GitHubStars";

const GITHUB = "https://github.com/letmepost/letmepost.dev";
const colLink =
  "inline-flex items-center gap-[7px] text-sm text-mut transition-colors hover:text-ink";
const colHead =
  "mb-[14px] font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint";

export function ClarityFooter() {
  const seen = new Set<string>();
  const platforms = PLATFORMS.filter((p) => {
    if (seen.has(p.slug)) return false;
    seen.add(p.slug);
    return true;
  });
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto max-w-[1208px] px-16 pt-14 pb-7 max-[1040px]:px-10 max-[560px]:px-[22px]">
        <div className="grid grid-cols-[1.4fr_repeat(4,1fr)] gap-8 max-[1040px]:grid-cols-3 max-[860px]:grid-cols-2 max-[560px]:grid-cols-1">
          <div className="max-[1040px]:col-span-full">
            <div className="mb-[14px]">
              <ClarityBrand size={22} />
            </div>
            <p className="mb-4 max-w-[30ch] text-[13.5px] leading-[1.55] text-mut">
              Open-source social publishing API. One POST, eight platforms.
              Apache-2.0.
            </p>
            <GitHubStars />
          </div>

          <div>
            <h4 className={colHead}>Product</h4>
            <ul className="m-0 list-none p-0">
              <li className="mb-[9px]">
                <Link href="/" className={colLink}>
                  Home
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/api/publishing" className={colLink}>
                  Publishing API
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/api/media" className={colLink}>
                  Media API
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/api/webhooks" className={colLink}>
                  Webhooks
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/pricing" className={colLink}>
                  Pricing
                </Link>
              </li>
              <li className="mb-[9px]">
                <a href="https://docs.letmepost.dev/changelog" className={colLink}>
                  Changelog
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4 className={colHead}>Integration</h4>
            <ul className="m-0 list-none p-0">
              {platforms.map((p) => (
                <li className="mb-[9px]" key={p.slug}>
                  <Link href={`/platforms/${p.slug}`} className={colLink}>
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className={colHead}>Company</h4>
            <ul className="m-0 list-none p-0">
              <li className="mb-[9px]">
                <Link href="/about" className={colLink}>
                  About
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/blog" className={colLink}>
                  Blog
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/agents" className={colLink}>
                  For agents{" "}
                  <span className="rounded bg-acc px-[5px] py-px font-mono text-[9px] uppercase tracking-[0.06em] text-white">
                    MCP
                  </span>
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/status" className={colLink}>
                  Status
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/privacy" className={colLink}>
                  Privacy
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/terms" className={colLink}>
                  Terms
                </Link>
              </li>
              <li className="mb-[9px]">
                <Link href="/contact" className={colLink}>
                  Contact
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h4 className={colHead}>Community</h4>
            <ul className="m-0 list-none p-0">
              <li className="mb-[9px]">
                <a href={GITHUB} target="_blank" rel="noopener" className={colLink}>
                  GitHub
                </a>
              </li>
              <li className="mb-[9px]">
                <a
                  href="https://bsky.app/profile/letmepost.dev"
                  target="_blank"
                  rel="noopener"
                  className={colLink}
                >
                  Bluesky
                </a>
              </li>
              <li className="mb-[9px]">
                <a
                  href="https://x.com/letmepostdotdev"
                  target="_blank"
                  rel="noopener"
                  className={colLink}
                >
                  X
                </a>
              </li>
              <li className="mb-[9px]">
                <a href="/rss.xml" className={colLink}>
                  RSS feed
                </a>
              </li>
              <li className="mb-[9px]">
                <a
                  href={`${GITHUB}/blob/main/CONTRIBUTING.md`}
                  target="_blank"
                  rel="noopener"
                  className={colLink}
                >
                  Contribute
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex items-center justify-between border-t border-line pt-6 font-mono text-xs text-faint max-[560px]:flex-col max-[560px]:items-start max-[560px]:gap-3">
          <span>
            letmepost.dev · © {year} · Apache-2.0 · built by Rose Kamal Love
          </span>
          <span>
            <Link href="/privacy" className="ml-[18px] text-faint hover:text-ink">
              Privacy
            </Link>
            <Link href="/terms" className="ml-[18px] text-faint hover:text-ink">
              Terms
            </Link>
          </span>
        </div>
      </div>
    </footer>
  );
}
