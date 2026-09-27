# @letmepost/mcp

MCP server for [letmepost.dev](https://letmepost.dev). Lets AI agents drive the full publishing API — posts, media, accounts, webhooks, API keys — through one MCP connection. The tool surface is generated from the canonical OpenAPI spec at startup, so every documented endpoint is reachable without a bespoke wrapper.

## Install

```sh
npx @letmepost/mcp
```

Or wire it into Claude Code:

```sh
claude mcp add letmepost npx @letmepost/mcp --env LMP_API_KEY=lmp_live_...
```

Cursor / Cline / any MCP client:

```json
{
  "mcpServers": {
    "letmepost": {
      "command": "npx",
      "args": ["@letmepost/mcp"],
      "env": { "LMP_API_KEY": "lmp_live_..." }
    }
  }
}
```

## Configuration

| Variable        | Required | Default                          | Description                                       |
| --------------- | -------- | -------------------------------- | ------------------------------------------------- |
| `LMP_API_KEY`   | yes      | —                                | Bearer token from https://dashboard.letmepost.dev |
| `LMP_API_BASE`  | no       | `https://api.letmepost.dev`      | Override for self-hosted deployments              |

## Tools

Tool names follow `{method}_{path}` with `{param}` segments rewritten as `by_{param}`. The current surface, generated from the OpenAPI spec:

- `post_v1_posts` — Publish or schedule a multi-target post. One call fans out to up to 25 connected accounts.
- `get_v1_posts` — List posts with cursor pagination, filterable by platform, status, error code, and time window.
- `get_v1_posts_by_id` — Fetch a single post with all its publish attempts.
- `get_v1_media` — List uploaded media. (Upload itself is multipart-only and exposed via the REST API; the MCP surface stays JSON-only.)
- `get_v1_accounts`, `get_v1_accounts_by_id`, `delete_v1_accounts_by_id` — Read and disconnect platform accounts.
- `post_v1_accounts_connect_by_platform`, `post_v1_accounts_connect_by_platform_complete` — Drive the connect handshake.
- `get_v1_accounts_by_id_pinterest_boards`, `post_v1_accounts_by_id_pinterest_boards`, `patch_v1_accounts_by_id_pinterest_default_board` — Pinterest board lifecycle.
- `post_v1_api_keys`, `get_v1_api_keys`, `delete_v1_api_keys_by_id` — Mint / list / revoke API keys.
- `post_v1_webhook_endpoints`, `get_v1_webhook_endpoints`, `get_v1_webhook_endpoints_by_id`, `patch_v1_webhook_endpoints_by_id`, `delete_v1_webhook_endpoints_by_id`, `post_v1_webhook_endpoints_by_id_test` — Outbound webhook management.

Each tool's `inputSchema` is a flat JSON schema with path / query / body fields merged into one object — the agent doesn't need to know which slot a field lives in. Idempotency keys are auto-injected on writes.

## Self-host

Self-host bypasses every platform approval gate. Bring your own credentials, every platform works the day you clone the repo. See [docs.letmepost.dev/self-host/quick-start](https://docs.letmepost.dev/self-host/quick-start).

## License

Apache 2.0.
