# flaude-server

Backend for Flaude — auth, LLM proxy, usage accounting. Runs on Cloudflare
Workers + D1.

This package is intentionally separate from the client (Tauri/Vite) app at the
repo root. Different toolchains, different deploy targets, different
`node_modules` — keeping them apart avoids tsconfig/resolver fights.

## What's in Phase 1 (this checkpoint)

- `POST /setup` — one-time admin bootstrap. Creates the first admin iff the
  users table is empty; 403s forever after.
- `POST /auth/login` — email + password → JWT (Bearer).
- `POST /auth/logout` — no-op (stateless JWT); endpoint exists as a
  client-facing convention.
- `GET  /auth/me` — auth smoke test; returns the current user row.

Phases 2–6 (LLM proxy, usage quota enforcement, conversation sync, client
auth UX, admin dashboard, web deploy) land in later checkpoints.

## Local setup (one-time)

```bash
cd server
pnpm install

# 1. Create the D1 database.
pnpm wrangler d1 create flaude
# → paste the printed `database_id` into wrangler.toml

# 2. Apply schema to the local D1 replica.
pnpm db:init

# 3. Create .dev.vars from the example and put a real JWT secret in it.
cp .dev.vars.example .dev.vars
# Then edit .dev.vars — any long random base64 string will do.
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

## Run

```bash
pnpm dev       # wrangler dev — http://localhost:8787
pnpm typecheck # tsc --noEmit, no bundling
```

## Bootstrap the first admin

With the server running:

```bash
curl -X POST http://localhost:8787/setup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"pickAGoodOne","display_name":"You"}'
```

Response:

```json
{
  "token": "eyJhbGciOi...",
  "user": { "id": 1, "email": "you@example.com", "display_name": "You", "role": "admin" }
}
```

Call `/setup` again and you'll get `403 setup already complete` — that's the
endpoint locking itself. Keep the token from the first call; you'll use it as
the Bearer for everything else.

## Smoke test

```bash
TOKEN='paste-the-token-here'

# Login (alternative to keeping the /setup token)
curl -X POST http://localhost:8787/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"pickAGoodOne"}'

# Who am I
curl http://localhost:8787/auth/me -H "Authorization: Bearer $TOKEN"
```

## Deploy

See [DEPLOY.md](DEPLOY.md) for the full from-zero walk-through (Cloudflare
account, D1 setup, secrets, first admin, client configuration, smoke test,
troubleshooting). The three-command summary:

```bash
pnpm wrangler secret put JWT_SECRET   # plus provider keys — see DEPLOY.md
pnpm db:init:remote                   # schema is idempotent, safe to re-run
pnpm deploy
```

## Design notes

- **JWT + Bearer header, not cookies.** Tauri's WebView has enough
  cross-origin cookie weirdness on Windows that skipping cookies entirely
  keeps auth uniform across Tauri and the future Web client.
- **bcryptjs, 12 rounds.** ~200ms per hash on a Worker isolate. Fine at login
  frequency for a 5-10 user deployment; bump to 13 rounds later if we ever
  hit the CPU wall, which we won't at this scale.
- **Users re-read from DB on every authenticated request.** The JWT carries
  enough claims to skip this, but the round-trip lets us disable a user via
  the DB and have it take effect immediately. One indexed PK lookup —
  basically free on D1.
- **Per-user quota is a nullable column.** `users.monthly_quota_tokens = NULL`
  falls back to the `MONTHLY_QUOTA_TOKENS` env var. Setting a concrete value
  (including `0`!) overrides it. Phase 2 enforces it.
