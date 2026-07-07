const SITE = "https://letmepost.dev";

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
