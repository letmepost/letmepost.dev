# Deployment

Production target: **Railway**.

| Surface | URL | Stack |
|---|---|---|
| Landing | `https://letmepost.dev` | Astro static site |
| Dashboard | `https://dashboard.letmepost.dev` | Next.js |
| API | `https://api.letmepost.dev` | Hono on Node 24, two services (web + worker) |

The landing and dashboard are deployed elsewhere (Vercel / Cloudflare Pages /
whatever you've set up). This document covers the API only.

## Prerequisites

You need accounts / project setup for:

- **Railway** — for the API + worker compute.
- **Neon** (or any managed Postgres) — set as `DATABASE_URL`.
- **Upstash Redis** (or any managed Redis) — set as `REDIS_URL`.
- DNS control for `letmepost.dev` (to point `api` at Railway).

The repo's `.env.example` (`apps/api/.env.example`) lists every variable the
API reads, with comments explaining what each one does and where to register
each platform's developer app.

## Architecture: two services, one image

`apps/api/Dockerfile` builds a single image. **Two Railway services run it**:

1. **`api`** — HTTP, public. Default start command:
   `pnpm --filter @letmepost/api start:api`
   (runs migrations, then `node dist/server.js`)
2. **`worker`** — BullMQ consumer, no public port. Override start command to:
   `pnpm --filter @letmepost/api start:worker`
   (just `node dist/queue/worker.js`, no migrations — the API service runs them)

Both services share the same env vars except the worker doesn't need a public
domain or healthcheck.

## First-time Railway setup

### 1. Create the project

```
railway init
```

Or via the dashboard: New Project → Deploy from GitHub repo → pick this repo.

### 2. Add the API service

The repo-root `railway.json` configures everything Railway needs.
**Critical:** under **Settings → Source → Root Directory**, leave it
**blank / `/`**. Do *not* set it to `/apps/api` — the Dockerfile is written
to use the monorepo root as the build context (it copies `pnpm-lock.yaml`,
every workspace `package.json`, etc. — none of those exist inside
`apps/api/`).

Confirm under **Settings → Build** (auto-populated from `railway.json`):

- **Builder:** Dockerfile
- **Dockerfile path:** `apps/api/Dockerfile`
- **Watch paths:** `apps/api/**`, `packages/schemas/**`, `pnpm-lock.yaml`

Under **Settings → Deploy** (also from `railway.json`):

- **Start command:** `pnpm --filter @letmepost/api start:api`
- **Health check path:** `/health`
- **Health check timeout:** 30s
- **Restart policy:** on-failure, max 5

### 3. Add the worker service

In the same Railway project: **+ New → GitHub Repo → same repo**. Same
**Root Directory: blank / `/`** as the API service.

Then override the start command — **Settings → Deploy → Custom Start Command**:

```
pnpm --filter @letmepost/api start:worker
```

Disable health checks for the worker service (it doesn't bind a port).
**Settings → Networking → Public networking: off**. Both services share
the same image; only the start command differs.

### 4. Wire up env vars

Set these on **both** services (Variables tab):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `REDIS_URL` | Upstash redis connection string |
| `KEK_MASTER` | `openssl rand -base64 32` — the AES-256-GCM master key. **Same value on both services.** Rotating it without re-wrapping all encrypted tokens will lock everyone out. |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `https://api.letmepost.dev` |
| `PUBLIC_API_BASE_URL` | `https://api.letmepost.dev` |
| `TRUSTED_ORIGINS` | `https://dashboard.letmepost.dev` |
| `CORS_ORIGINS` | `https://dashboard.letmepost.dev` |
| `COOKIE_DOMAIN` | `.letmepost.dev` (note the leading dot) |
| `NODE_ENV` | `production` (Railway sets this automatically) |
| Platform OAuth | `LINKEDIN_CLIENT_ID/SECRET`, `TWITTER_CLIENT_ID/SECRET`, `PINTEREST_CLIENT_ID/SECRET`, `YOUTUBE_CLIENT_ID/SECRET`, `META_APP_ID/SECRET` — fill as the developer apps come back from review. |

The dashboard at `dashboard.letmepost.dev` needs `NEXT_PUBLIC_API_URL=https://api.letmepost.dev` set on its own host.

### 5. Custom domain

API service → **Settings → Networking → Custom Domain**. Add
`api.letmepost.dev`. Railway gives you a CNAME target — point your DNS at it.

### 6. First deploy

Push to the branch Railway is watching (default `main`). The API service
boots, runs migrations on the way up, then starts the server. Worker boots
in parallel.

Verify:

```
curl https://api.letmepost.dev/health
# {"status":"ok"}
```

### 7. Seed (optional, dev/staging)

Don't run `seed:demo` against production — it wipes user data. For a
staging environment with a separate database, you can:

```
# locally, against the staging DATABASE_URL
DATABASE_URL=<staging url> pnpm --filter @letmepost/api seed:demo
```

## Updating the deploy

Each push to `main` triggers a redeploy of any service whose **watch paths**
match the changed files. Schema changes:

1. Generate the migration locally: `pnpm --filter @letmepost/api db:generate`
2. Commit the new SQL file under `apps/api/drizzle/`
3. Push — the API service applies it on boot before the new code starts serving.

## Rollback

Railway → Service → Deployments → pick a previous one → **Redeploy**.
Migrations are forward-only; if you need to roll back across a migration,
restore the database from a Neon point-in-time snapshot first.

## Smoke test after deploy

```bash
# 1. Health
curl https://api.letmepost.dev/health

# 2. Sign up + dashboard handshake (in a browser, on dashboard.letmepost.dev)

# 3. End-to-end via the dashboard:
#    - Create an org
#    - Mint an API key (copy the plaintext)
#    - Connect Bluesky (the only platform that doesn't need OAuth review)
#    - Send a test post via the home accordion's "Send test post" button
#    - Watch the post log fill in
```

## Self-host parity

The Docker image runs on any container host. Compose / Kubernetes setup is
out of scope for this doc — point `DATABASE_URL` and `REDIS_URL` at any
Postgres + Redis, set the rest of the env vars from `apps/api/.env.example`,
and the same image works.
