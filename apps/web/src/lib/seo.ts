/**
 * Shared JSON-LD builders for marketing pages. Output drops into the
 * `jsonLd` prop on BaseLayout and renders inside `<script type="application/ld+json">`.
 *
 * Schema.org @types we use:
 *   - FAQPage / Question / Answer  (pricing, platform pages, agents, etc.)
 *   - Product / Offer              (pricing — enables price-snippet rich result)
 *   - BreadcrumbList               (blog posts, platform/api detail)
 *   - Person                       (blog author bylines)
 *
 * Each builder returns a single object (or array, for breadcrumbs)
 * that satisfies the JsonLdGraph type in BaseLayout.
 */

const SITE = "https://letmepost.dev";

/**
 * Serialize a JSON-LD graph for safe embedding inside a
 * `<script type="application/ld+json">` body. `JSON.stringify` does not
 * escape `<`, `>`, `&`, or the U+2028/U+2029 line separators, so a value
 * sourced from the (third-party-writable) Notion blog — a post title or
 * description — could contain `</script>` and break out of the script
 * element into live HTML. Escaping these as JSON `\uXXXX` sequences keeps
 * the payload valid JSON (parsers decode them back) while making it
 * impossible for the raw text to terminate the script element or inject
 * markup.
 */
export function serializeJsonLd(graph: unknown): string {
  return JSON.stringify(graph)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export type FaqEntry = { q: string; a: string };

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

export function faqPageSchema(faqs: FaqEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: stripHtml(f.a) },
    })),
  };
}

export type PricingOffer = {
  name: string;
  price: number;
  description: string;
};

export function pricingProductSchema(offers: PricingOffer[]) {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${SITE}/#product`,
    name: "letmepost.dev",
    description:
      "Open-source social media publishing API for developers and AI agents.",
    brand: { "@type": "Brand", name: "letmepost.dev" },
    image: `${SITE}/og-image.png`,
    url: `${SITE}/`,
    offers: offers.map((o) => ({
      "@type": "Offer",
      name: o.name,
      price: o.price,
      priceCurrency: "USD",
      description: o.description,
      availability: "https://schema.org/InStock",
      url: `${SITE}/pricing`,
    })),
  };
}

export type BreadcrumbItem = { name: string; url?: string };

export function breadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {}),
    })),
  };
}

export const ROSE_PERSON_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "Person",
  "@id": `${SITE}/about#rose`,
  name: "Rose Kamal Love",
  url: `${SITE}/about`,
  jobTitle: "Founder, letmepost.dev",
  sameAs: [
    "https://github.com/rosekamallove",
    "https://x.com/rosekamallove",
    "https://bsky.app/profile/rosekamallove.dev",
  ],
};
