# @letmepost/cli

Command-line client for [letmepost.dev](https://letmepost.dev). Publish to Bluesky, X, LinkedIn, Threads, Instagram, Facebook, Pinterest from your terminal or any agentic shell.

## Install

```bash
npm install -g @letmepost/cli
# or
npx @letmepost/cli --help
```

Binary name: `lmp`. Requires Node 18+.

## Login

```bash
lmp login
```

Opens your browser for OAuth 2.1 with PKCE, trades the token for a long-lived API key, saves to `~/.letmepost/config.json`. Falls back to API-key paste if the OAuth provider is unreachable.

## Usage

```bash
lmp post "Shipping today" --to=twitter,bluesky
lmp post "Reels are live" --to=instagram --media=./hero.mp4
lmp post "Big news" --to=linkedin --schedule=2026-05-20T18:00:00Z

lmp accounts list
lmp accounts list --platform bluesky
lmp accounts disconnect acc_01HX...

lmp posts list --limit 50 --status rejected
lmp posts get pst_01HX...

lmp profiles list
lmp profiles use prof_01HX...
lmp profiles current

lmp whoami
lmp version
lmp logout
```

Per-call profile override:

```bash
lmp post "hello" --to=bluesky --profile prof_01HX...
```

## Environment overrides

| Variable        | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `LMP_API_KEY`   | Use this Bearer key instead of the stored credential.                      |
| `LMP_API_BASE`  | Override the API host (defaults to `https://api.letmepost.dev`).           |

## Exit codes

- `0` — success
- `1` — config / auth / argument error
- `2` — API call failed (full or partial — useful for shell pipelines)

## Self-host

```bash
LMP_API_BASE=https://api.yourdomain.com lmp login
```

## Docs

- Full reference: https://docs.letmepost.dev/agents/cli
- API: https://docs.letmepost.dev
- MCP server (sibling): https://docs.letmepost.dev/agents/mcp

## License

Apache 2.0.
