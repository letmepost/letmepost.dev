# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities **privately**, not via public issues.

**Two reporting channels — pick whichever you prefer:**

1. **GitHub private security advisory** (recommended) —
   [open a draft advisory](https://github.com/letmepost/letmepost.dev/security/advisories/new)
   on this repo. Lets us collaborate on a fix in private and coordinate a CVE if needed.

2. **Email** — `kamal@letmepost.dev`. PGP not required; the inbox is
   monitored daily.

Please include:

- A clear description of the issue and its impact
- Reproduction steps (or a minimal PoC)
- The component affected (api / worker / dashboard / web / mcp / cli / sdk-ts)
- The commit SHA or deployed version you tested against

## Response timeline

We aim to:

- Acknowledge your report within **2 business days**
- Provide an initial assessment within **7 days**
- Ship a fix or document a mitigation within **30 days** for high-severity issues
- Disclose publicly within **90 days** of the original report (coordinated with you)

If the issue is being actively exploited, we will expedite both the fix and the disclosure.

## Scope

**In scope:**

- `apps/api` — the public REST API (`api.letmepost.dev`)
- `apps/worker` — the BullMQ worker process
- `apps/dashboard` — the web dashboard (`dashboard.letmepost.dev`)
- `apps/web` — the marketing site (`letmepost.dev`)
- `apps/mcp` — the MCP server (hosted at `api.letmepost.dev/mcp` + the
  `@letmepost/mcp` stdio binary)
- `apps/cli` — the `@letmepost/cli` package
- `packages/sdk-ts` — the official TypeScript SDK
- The generated Python (`letmepost`) and Go (`github.com/letmepost/letmepost-go`) SDKs
- Docker images published from this repo (self-host)

**Out of scope** (please report to the upstream vendor directly):

- Upstream platform APIs (Bluesky AT Proto, Twitter/X v2, LinkedIn, Meta
  Graph, Pinterest v5, TikTok Content Posting API)
- OAuth provider security issues (Google, GitHub, the platforms above)
- Third-party infrastructure (Railway, Vercel, NeonDB, Upstash, Resend,
  Lemon Squeezy, Sentry, Axiom, PostHog)
- DoS / volumetric attacks against the hosted service (file abuse reports
  to the hosting provider)
- Self-hosted deployments where the operator has bypassed the documented
  configuration (e.g. running with `BETTER_AUTH_SECRET` unset)

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to follow this policy
- Avoid privacy violations, data destruction, or service disruption
- Give us reasonable time to fix the issue before public disclosure

We're a small team — please be patient if we take a few extra days during
launches. We will credit you in the advisory unless you ask us not to.
