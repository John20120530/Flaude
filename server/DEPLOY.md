# Deploying flaude-server

From-zero walk-through for self-hosting the Flaude backend on Cloudflare
Workers + D1. If you just want a dev server, [README.md](README.md) covers
local setup — this doc is specifically about production.

Target audience: you have a Cloudflare account, pnpm installed, and you
can read error messages. Total hands-on time is about 15 minutes if
everything goes right; plan 30 if it's your first Workers + D1 project.

---

## What you'll end up with

- A Workers script (`flaude-server`) at `https://flaude-server.<your-subdomain>.workers.dev`
  (or a custom domain if you bring one — see the last section).
- A D1 database (`flaude`) holding users, conversations, projects, artifacts,
  and usage logs. **Free-tier quota** is 5 GB storage + 5 M reads/day — a
  5-10 user group won't get close.
- A daily cron (03:17 UTC) that purges conversations soft-deleted > 90 days
  ago.
- One or more admin-created user accounts, each signed in via JWT Bearer
  from the desktop / web client.

Free tier on Workers is 100k requests/day; at ~10 users averaging 200
requests each that's comfortable headroom.

---

## 1. Prerequisites

```bash
# Wrangler (the Cloudflare CLI) ships as a dev-dep of the server package,
# so you don't need a global install. But you do need to be logged in.
cd server
pnpm install
pnpm wrangler login
```

`wrangler login` opens a browser tab to authorise the CLI against your
Cloudflare account. If you're running on a headless box, copy the URL it
prints and open it elsewhere — the OAuth dance also accepts device-code
flow via `wrangler login --browser=false`.

Verify:

```bash
pnpm wrangler whoami
```

Should show your email + account id.

---

## 2. Create the D1 database

One-shot. D1 databases are per-account, globally replicated, and free up
to the limits above.

```bash
pnpm wrangler d1 create flaude
```

Output includes a block like:

```
[[d1_databases]]
binding = "DB"
database_name = "flaude"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` and paste it into
[wrangler.toml](wrangler.toml) replacing the existing id:

```toml
[[d1_databases]]
binding = "DB"
database_name = "flaude"
database_id = "YOUR-NEW-UUID-HERE"
```

**Why not keep the default id:** that id points at the author's personal
D1 database and Cloudflare will reject pushes against it from any other
account. You want your own.

---

## 3. Apply the schema

All table creates in [schema.sql](schema.sql) are `IF NOT EXISTS`, so this
command is idempotent — safe to re-run on every upgrade, safe to run twice
by accident.

```bash
pnpm db:init:remote
```

That applies users, usage_log, conversations, messages, projects, and
artifacts — the whole schema, not incremental. **You do NOT need to run the
numbered migration files in `migrations/` for a fresh deploy.** Those are
only for upgrading an older deployment that predates the columns
in question. A fresh install gets everything from `schema.sql`.

Sanity-check:

```bash
pnpm wrangler d1 execute flaude --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expect: `artifacts / conversations / messages / projects / usage_log / users`.

---

## 4. Push secrets

Secrets are per-environment and never leave Cloudflare's vault once pushed.

### Required

```bash
# JWT signing key — any long random string works. 48 bytes base64 is plenty.
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
pnpm wrangler secret put JWT_SECRET
# → paste the string from the node command above
```

If you lose this secret, every user has to re-log in (JWTs signed with the
old key won't verify). **Back it up somewhere your password manager owns.**

### Optional — LLM provider keys

The client talks to the server which proxies to the underlying model
provider. A model whose provider key is missing returns `500 server not
configured` at request time, so only set the keys you plan to actually
serve. You can always add more later.

```bash
# DeepSeek — https://platform.deepseek.com/api_keys
pnpm wrangler secret put DEEPSEEK_API_KEY

# Qwen (Alibaba DashScope, OpenAI-compatible) — https://dashscope.console.aliyun.com
pnpm wrangler secret put QWEN_API_KEY

# Moonshot Kimi — https://platform.moonshot.cn
pnpm wrangler secret put MOONSHOT_API_KEY
```

### Optional — web search

Powers the `web_search` built-in tool. Omit to disable the tool; users see
a friendly "admin hasn't configured Web Search" message.

```bash
# 博查 (BochaAI) — https://open.bochaai.com
pnpm wrangler secret put BOCHA_API_KEY
```

### Verifying what's pushed

```bash
pnpm wrangler secret list
```

Don't commit any of these — `.dev.vars` is git-ignored and only lives on
your laptop for local development.

---

## 5. (Optional) Tweak public variables

Non-secret knobs live in [wrangler.toml](wrangler.toml) under `[vars]` (dev)
and `[env.production.vars]` (prod):

| Var | Default | What it does |
|-----|---------|--------------|
| `APP_ENV` | `production` | Logged in the `GET /` health payload. |
| `JWT_ISSUER` | `flaude` | `iss` claim + issuer check on login. |
| `MONTHLY_QUOTA_TOKENS` | `300000` | Per-user monthly cap. Per-user overrides set via admin UI or `admin_update_user` win over this. |

If you bump the default quota, edit both the `[vars]` and
`[env.production.vars]` blocks so `wrangler dev` stays consistent with
production.

---

## 6. Deploy the worker

```bash
pnpm deploy
```

This runs `wrangler deploy`. Output includes:

```
Published flaude-server (x.xx sec)
  https://flaude-server.<your-subdomain>.workers.dev
Current Deployment ID: ...
```

**Note the URL** — that's your API base. Keep it handy for step 8.

Verify:

```bash
curl https://flaude-server.<your-subdomain>.workers.dev/
# → {"name":"flaude-server","env":"production","ok":true}
```

The `env: "production"` field confirms the prod vars block took effect.

---

## 7. Bootstrap the first admin

The server has a `POST /setup` endpoint that runs exactly once: when the
users table is empty it creates the first admin and returns a JWT; every
subsequent call returns `403 setup already complete` forever.

```bash
SERVER=https://flaude-server.<your-subdomain>.workers.dev

curl -X POST $SERVER/setup \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "you@example.com",
    "password": "pick-something-strong",
    "display_name": "You"
  }'
```

Response:

```json
{ "token": "eyJhbGciOi...", "user": { "id": 1, "email": "...", "role": "admin" } }
```

Save that token somewhere safe — you don't strictly *need* it (you can log
in again with email + password), but having it means you can smoke-test
without pulling up a client.

Password policy: minimum 8 characters, no complexity rules. bcrypt at 12
rounds means brute-forcing any 8-char password still takes years, but a
dictionary word is a dictionary word — use a password manager.

---

## 8. Point the client at your server

Build the client with the server URL baked in.

### For the desktop app (Tauri)

```bash
# At the repo root, not inside server/
cd ..
echo 'VITE_FLAUDE_SERVER_URL=https://flaude-server.<your-subdomain>.workers.dev' > .env.local
pnpm tauri:build
```

Installers land in `src-tauri/target/release/bundle/`. The URL is baked
into the bundle at compile time — if you change servers later you have to
rebuild.

### For local dev / browser testing

```bash
# .env.local at repo root, then:
pnpm dev
```

`VITE_FLAUDE_SERVER_URL` with no protocol defaults to the local `http://127.0.0.1:8787`.

### Verifying from the client

Open the app, go to **Settings → 账户**. The `服务端` row should show your
URL. If it says `http://127.0.0.1:8787`, the env var didn't take — confirm
the file is literally `.env.local` at the repo root, not inside `server/`.

---

## 9. End-to-end smoke test

```bash
SERVER=https://flaude-server.<your-subdomain>.workers.dev
TOKEN='paste-token-from-step-7'

# Who am I
curl $SERVER/auth/me -H "Authorization: Bearer $TOKEN"

# Admin: list users
curl $SERVER/admin/users -H "Authorization: Bearer $TOKEN"

# Sync: initial pull (empty result is expected for a new account)
curl "$SERVER/sync/pull?since=0" -H "Authorization: Bearer $TOKEN"
```

If all three return JSON (not HTML error pages), you're live.

From the client side, open **Settings → 管理员**, add a user, log in as
them, have a chat. The token counter on the admin page should tick up
within 30 seconds (it auto-polls).

---

## Ongoing operations

### Adding users

Go to **Settings → 管理员 → 新建用户** in the desktop client. The admin
UI generates the initial password, copies it to the clipboard once, then
never shows it again — send it to the user via whatever out-of-band channel
you normally use (WeChat, Telegram, Signal).

### Rotating a secret

Same command as step 4 — `wrangler secret put <NAME>` overwrites.
Rotating `JWT_SECRET` invalidates every user's session, forcing a re-login.
Rotating a provider key is transparent.

### Applying a new migration

When a future Flaude version ships a new migration file under
`server/migrations/`, run it against the remote DB:

```bash
pnpm wrangler d1 execute flaude --remote --file=./migrations/NNN_whatever.sql
```

The numbered files are append-only and idempotent (same `IF NOT EXISTS`
discipline as schema.sql), so running them twice is safe. There's no
migration-state table — the authority on "what's applied" is the actual
schema.

### Tailing logs

```bash
pnpm wrangler tail
```

Streams `console.log` / `console.error` from the deployed worker in real
time. Useful for debugging auth failures or upstream provider errors.

### Rolling back

Wrangler keeps a history of deployments.

```bash
pnpm wrangler deployments list       # show recent deploys
pnpm wrangler rollback <deploy-id>   # atomic switch to an older build
```

DB schema changes aren't rolled back automatically — if a bad migration
makes it out, fix forward with another migration rather than rolling back.

---

## Troubleshooting

**`401 Unauthorized` on every request after deploy.** Check the client's
`VITE_FLAUDE_SERVER_URL` matches what you deployed — a trailing slash or
an http vs https mismatch will 401 because the CORS / route layer never
sees the right URL. Also confirm you pushed `JWT_SECRET` (without it
login silently fails).

**`403 setup already complete` but I never called /setup.** The users
table has at least one row — maybe from a previous deploy against the
same D1. Wipe it with `pnpm wrangler d1 execute flaude --remote --command
'DELETE FROM users'` and re-run step 7, or log in with the old admin's
credentials if you still have them.

**`500 server not configured` on a specific model.** That provider's key
isn't set. Run `wrangler secret list` to confirm and `wrangler secret put
<PROVIDER>_API_KEY` to fix.

**Client says CORS error.** Workers sets its own CORS headers; if you
reverse-proxy in front of it (e.g. Cloudflare Transform Rules stripping
headers), re-check. The worker doesn't need any fronting — point the
client directly at `*.workers.dev`.

**`d1 create` says "already exists".** The name `flaude` is taken on your
account from a previous experiment. Either reuse it (`wrangler d1 list`
shows the id) or create under a different name and update `database_name`
+ `database_id` in wrangler.toml accordingly.

---

## Custom domain (optional)

Out of the box your server lives at `flaude-server.<subdomain>.workers.dev`.
To use a domain you own:

1. Add the domain to your Cloudflare account (DNS must be Cloudflare-managed).
2. In the dashboard: **Workers & Pages → flaude-server → Settings → Domains
   & Routes → Add custom domain.**
3. Point the client at the new URL and rebuild.

No wrangler.toml change is required — custom domains are configured in the
dashboard, not in the TOML.

---

## Cost napkin math

At 10 active users × 20 chat turns/day × 2 round trips (chat + sync) = 400
requests/day. Workers free tier is 100,000/day. D1 storage is ~1 MB per
user after a year of moderate use (conversations dominate); at 1,000 users
you're still under the free 5 GB cap. DeepSeek at $0.28/M output tokens
with a 300k monthly cap per user = $0.08 max per user per month. A 10-
person group runs ~$1/month in LLM cost, $0 in Cloudflare cost.

If you scale past the free tier, Workers Paid is $5/month for 10 M
requests and D1 Paid adds up similarly. No surprises.
