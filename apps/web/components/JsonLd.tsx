import { serializeJsonLd } from "@/lib/seo";

export function JsonLd({ graphs }: { graphs: Record<string, unknown>[] }) {
  return (
    <>
      {graphs.map((g, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(g) }}
        />
      ))}
    </>
  );
}
