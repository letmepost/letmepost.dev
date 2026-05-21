# @letmepost/sdk

Official TypeScript SDK for [letmepost.dev](https://letmepost.dev). Resource-grouped client over the publishing API with typed errors, automatic idempotency, retries, and an HMAC webhook verifier. Zero runtime dependencies.

## Install

```sh
npm install @letmepost/sdk
```

Node `>=18` (uses the platform `fetch` and `crypto.randomUUID`). Works in Bun and Deno too.

## Quick start

```ts
import { Letmepost } from "@letmepost/sdk";

const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY! });

const result = await lmp.posts.create({
  targets: [{ platform: "bluesky" }, { platform: "twitter" }],
  text: "Shipped multi-target publishing today.",
});

console.log(result.status); // "published" | "partial_failed" | "failed" | "queued"
for (const r of result.results) {
  console.log(`${r.platform}: ${r.status} ${r.uri ?? ""}`);
}
```

## Authentication

Mint an API key in the [dashboard](https://dashboard.letmepost.dev) and pass it in `apiKey`. See [docs.letmepost.dev/authentication](https://docs.letmepost.dev/authentication) for the full flow, scopes, and `lmp_test_…` vs `lmp_live_…` prefixes.

```ts
const lmp = new Letmepost({
  apiKey: process.env.LMP_API_KEY!,
  baseUrl: "https://api.letmepost.dev", // override for self-hosted
  retries: 3,                           // default
  fetch: globalThis.fetch,              // override to inject tracing
});
```

## Errors

Every non-2xx response is mapped to a typed subclass of `LetmepostError`. Catch the base class for coarse handling, branch on the subclass for surgical retries. Each error carries the full envelope: `code`, `rule`, `platform`, `platformResponse`, `remediation`, `docUrl`, `ruleUrl`, `requestId`, and the HTTP `status`.

```ts
import {
  Letmepost,
  LetmepostError,
  PreflightFailedError,
  RateLimitedError,
} from "@letmepost/sdk";

try {
  await lmp.posts.create({ targets: [{ platform: "bluesky" }], text: "…" });
} catch (err) {
  if (err instanceof PreflightFailedError) {
    console.error(`Preflight failed: ${err.rule}`);
    console.error(`Fix: ${err.remediation}`);
    console.error(`Docs: ${err.ruleUrl}`);
  } else if (err instanceof RateLimitedError) {
    console.warn(`Rate limited. Retry after ${err.retryAfterSeconds}s`);
  } else if (err instanceof LetmepostError) {
    console.error(`[${err.code}] ${err.message} (request ${err.requestId})`);
  } else {
    throw err;
  }
}
```

Subclasses: `ValidationError`, `PreflightFailedError`, `PlatformAuthError`, `PlatformRejectedError`, `PlatformUnavailableError`, `PlatformNotEnabledError`, `InternalError`, `UnauthenticatedError`, `UnauthorizedError`, `NotFoundError`, `IdempotencyConflictError`, `RateLimitedError`.

## Webhooks

Verify deliveries from the [outbound webhook system](https://docs.letmepost.dev/webhooks). The signature is `sha256=<hex>` over the raw request body, in the `X-Letmepost-Signature` header.

```ts
import { verifyWebhook } from "@letmepost/sdk/webhooks";

// Express, Hono, or native http. Pass the *raw* body string, before JSON parsing.
const event = verifyWebhook<{ id: string; type: string; data: unknown }>({
  body: rawRequestBody,
  signature: req.headers["x-letmepost-signature"],
  secret: process.env.LMP_WEBHOOK_SECRET!,
});

switch (event.type) {
  case "post.published":
    // ...
    break;
}
```

`verifyWebhook` throws if the signature doesn't match or the body isn't valid JSON. For a non-throwing variant returning `boolean`, use `verifyWebhookSignature`.

## Idempotency

Every non-GET request gets an `Idempotency-Key` header automatically (UUID v4). Replays within 24 hours return the original response. Conflicting bodies under the same key surface as `IdempotencyConflictError` (HTTP 409).

```ts
// Override the auto-generated key (useful for client-side deduplication):
await lmp.posts.create(
  { targets: [{ platform: "bluesky" }], text: "hi" },
  { idempotencyKey: "post-launch-2026-05-21-001" },
);
```

## Retries

5xx and 429 responses are retried with exponential backoff (3 attempts by default). `Retry-After` headers are honored, capped at 30s per retry. Disable retries per call via `{ retries: 0 }`.

## Self-hosting

letmepost.dev is Apache 2.0. Point the SDK at your own deployment with `baseUrl`. The hosted and self-hosted APIs are identical: same wire shape, same error envelope.

```ts
const lmp = new Letmepost({
  apiKey: "…",
  baseUrl: "https://api.your-host.example.com",
});
```

Source: [github.com/rosekamallove/letmepost.dev](https://github.com/rosekamallove/letmepost.dev). Docs: [docs.letmepost.dev](https://docs.letmepost.dev).

## License

[Apache 2.0](../../LICENSE).
