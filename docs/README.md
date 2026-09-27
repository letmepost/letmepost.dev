# letmepost.dev docs

Mintlify-backed developer documentation for [letmepost.dev](https://letmepost.dev). Renders at <https://docs.letmepost.dev>.

## Local preview

```bash
npm i -g mint
cd docs
mint dev      # serves on http://localhost:3000
```

The CLI hot-reloads on save. No build step.

## Repository wiring

Mintlify pulls from this repo via the [Mintlify GitHub App](https://github.com/apps/mintlify). On every push to the configured branch, Mintlify rebuilds and deploys docs.letmepost.dev.

When configuring the integration in Mintlify's dashboard:

- **Repository:** `rosekamallove/letmepost.dev`
- **Branch:** `main` (or whichever branch is the docs source of truth)
- **Subdirectory:** `docs/` ← this directory; tells Mintlify where `docs.json` lives

## File map

```
docs/
├── docs.json                ← navigation, theme, colors, footer
├── index.mdx                ← root landing (rendered at /)
├── quickstart.mdx
├── authentication.mdx
├── idempotency.mdx
├── changelog.mdx
├── pricing.mdx
├── cli.mdx                  ← stub (CLI ships post-launch)
├── mcp.mdx                  ← stub (MCP server ships post-launch)
├── guides/                  ← workflow guides
│   ├── connect-account.mdx
│   ├── publish-post.mdx
│   ├── schedule-post.mdx
│   ├── upload-media.mdx
│   └── self-host.mdx
├── errors/                  ← one page per error code (11)
│   ├── index.mdx
│   ├── validation_failed.mdx
│   └── ...
├── preflight/               ← one page per preflight rule (61)
│   ├── index.mdx
│   ├── bluesky-text-max_graphemes.mdx
│   ├── instagram-media-reachable.mdx       ← the canonical 2207052 page
│   └── ...
├── platforms/               ← per-platform integration guides (7)
├── webhooks/                ← per-event pages (8) + index
├── sdks/                    ← {typescript,python,go}.mdx (stubs today)
├── api-reference/
│   └── openapi.json         ← canonical OpenAPI 3.1 spec
├── images/                  ← logos, OG art (TODO)
└── .scripts/
    ├── mintlify-port.py     ← one-off transformer (Astro → Mintlify), kept for reruns
    └── validate.py          ← link checker, nav-vs-disk audit, OpenAPI sanity
```

## Maintaining the OpenAPI reference

The canonical schemas live in [`packages/schemas/src/`](../packages/schemas/src/) as Zod definitions. To regenerate `api-reference/openapi.json`, run the OpenAPI generator (lives in `~/dev/side-projects/lmp/openapi/` until it's reintegrated into the schemas package):

```bash
cd ~/dev/side-projects/lmp/openapi
npx tsx emit-openapi.ts
cp openapi.json /path/to/letmepost.dev/docs/api-reference/openapi.json
```

15 of the 19 endpoints are summary-only stubs in the current spec. Filling them out follows the pattern established for `POST /v1/posts` in `openapi.ts`.

## Validating before push

```bash
python3 .scripts/validate.py
```

Asserts every page in `docs.json` exists, no internal links are broken, and the OpenAPI spec parses.

## Conventions

- **No H1 in MDX bodies.** Mintlify renders the page title from frontmatter `title`. Adding an `# h1` produces a duplicate.
- **Frontmatter fields used:** `title` (required), `description`, `icon` (optional, Lucide icon name), `mode: wide` (optional, full-width).
- **Code blocks** use ` ```<lang> <filename> ` for the title bar treatment Mintlify renders by default.
- **Multi-language samples** use `<CodeGroup>`. Sticky language tab is built-in.
- **Internal links** are absolute paths from the docs root: `/quickstart`, `/errors/preflight_failed`, `/api-reference/posts/create-post`. No trailing slashes, no `/docs/` prefix.
- **External links** use full URLs.

## Style

- Voice: direct, dense, no marketing-speak. Match `apps/web/src/pages/index.astro` (the landing).
- No emojis in body copy or headings.
- No marketing language inside the docs — this is reference material; marketing lives at `letmepost.dev/`.
- Source-of-truth always wins over inference. When a behavior contradicts what you'd expect, read the code (`apps/api/src/`).

## Source-of-truth map

| doc topic | source file in repo |
|---|---|
| Error codes | `packages/schemas/src/errors.ts` |
| Post / media / platform constants | `packages/schemas/src/post.ts` |
| Webhook event types | `packages/schemas/src/webhook-events.ts` |
| Preflight rule ids | `apps/api/src/platforms/*/preflight.ts` (grep `rule:`) |
| OAuth scopes per platform | `apps/api/src/platforms/_shared/scopes.ts` |
| Endpoint behavior | `apps/api/src/routes/*.ts` |
| Per-platform publisher behavior | `apps/api/src/platforms/<platform>/publisher.ts` |
