# 18 — Installation

End-to-end setup for a **new** Cloudflare account/zone.  
Synthetic names only (`example.com`, `me@gmail.com`). Swap for your values.

**Prereqs**

| Tool | Notes |
|------|--------|
| Node.js | **≥ 20** |
| npm | comes with Node |
| Cloudflare account | Workers + Email Routing + D1 + R2 |
| Domain on Cloudflare | Email Routing enabled; destination address verified |
| SMTP provider | Any SMTP that accepts authenticated submission (port **465** recommended) |
| `wrangler` | via `npx wrangler` (devDependency) or global |

Authenticate once:

```bash
npx wrangler login
# or: export CLOUDFLARE_API_TOKEN=…   # Account permission: Workers, D1, R2, Email Routing as needed
```

---

## 1. Clone and install

```bash
git clone https://github.com/reynhartono/cf-email-gateway.git
cd cf-email-gateway
npm install
npm test
```

---

## 2. Create D1 and R2

```bash
npx wrangler d1 create cf-email-gateway
npx wrangler r2 bucket create cf-email-gateway
```

Copy the printed **database_id** (and your **account_id** from the dashboard or `wrangler whoami`).

---

## 3. Configure `wrangler.toml`

```bash
cp wrangler.toml.example wrangler.toml
# edit account_id + database_id
```

Minimal shape (use **your** ids — do not commit real account/D1 ids or secrets):

```toml
name = "cf-email-gateway"
main = "src/index.js"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]
account_id = "<YOUR_CLOUDFLARE_ACCOUNT_ID>"

[[rules]]
type = "Text"
globs = ["**/*.yaml", "**/*.yml"]
fallthrough = true

[[d1_databases]]
binding = "DB"
database_name = "cf-email-gateway"
database_id = "<YOUR_D1_DATABASE_ID>"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "cf-email-gateway"

[vars]
SERVICE_NAME = "cf-email-gateway"
```

Bindings **must** stay named `DB` and `ARCHIVE` (code expects them).

---

## 4. Apply D1 migrations

```bash
npx wrangler d1 migrations apply cf-email-gateway --remote
# optional local:
# npx wrangler d1 migrations apply cf-email-gateway --local
```

---

## 5. Routing config

1. Copy the example and edit:

```bash
cp config/routing.example.yaml config/routing.local.yaml
# edit: default_inbox, token_auth.authorized_from, domains.<apex>.send_as
```

2. At minimum set:

| Field | Purpose |
|-------|---------|
| `default_inbox` | Verified Email Routing destination (e.g. your Gmail) |
| `token_auth.authorized_from` | Gmail (or other) From addresses allowed for reply hop + send-proxy |
| `domains.example.com.send_as.enabled` | `true` for outbound From / compose / send-proxy on that apex |
| `compose.default_from` | Optional default compose From |
| `reply_tokens.enabled` | `true` (default) for X-CFEG headers on forward |

3. Put the **file contents** into a Worker secret (not git):

```bash
npx wrangler secret put ROUTING_YAML < config/routing.local.yaml
```

`config/routing.local.yaml` is gitignored. Dashboard plain-text env vars are wiped by `wrangler deploy` — **secrets only**.

The Worker **requires** non-empty `ROUTING_YAML` at runtime (Q41). It does **not** fall back to `config/routing.example.yaml`. After deploy, confirm:

```bash
curl -sS "https://cf-email-gateway.<account>.workers.dev/health"
# expect: {"ok":true,"service":"cf-email-gateway","routing_ok":true}
```

If `routing_ok` is `false`, put the secret and **redeploy**. For local `wrangler dev` only, you may set `ALLOW_EXAMPLE_ROUTING=1` in `.dev.vars` to use the bundled example — never on production.

---

## 6. SMTP and compose secrets

```bash
printf '%s' 'mail.example.com' | npx wrangler secret put SMTP_HOST
printf '%s' 'smtp-user'         | npx wrangler secret put SMTP_USERNAME
printf '%s' 'smtp-pass'         | npx wrangler secret put SMTP_PASSWORD
printf '%s' '465'               | npx wrangler secret put SMTP_PORT   # optional; default 465

# Long random token for POST /v1/compose and selftests
openssl rand -hex 32 | npx wrangler secret put COMPOSE_API_TOKEN
```

Aliases accepted in code: `SMTP_USER` / `SMTP_PASS` as well as `SMTP_USERNAME` / `SMTP_PASSWORD`.

Your ESP must allow sending as the From addresses you enable under `domains.*.send_as` (SPF/DKIM on the zone).

---

## 7. Deploy the Worker

```bash
npx wrangler deploy
```

Note the URL, e.g. `https://cf-email-gateway.<account>.workers.dev`.

**After every `secret put`, deploy again** so the isolate picks up secrets.

---

## 8. Wire Email Routing → Worker

1. Cloudflare Dashboard → domain → **Email** → **Email Routing** (enable if needed).  
2. Add/verify a **destination address** matching `default_inbox`.  
3. Point **catch-all** (and/or individual addresses) to **Worker** → `cf-email-gateway`  
   (not “forward to Gmail only”, or send-proxy / tokens never run).

IaC users: catch-all `action { type = "worker"; value = ["cf-email-gateway"] }` in your infra repo.

---

## 9. Verify

### Health

```bash
curl -sS "https://cf-email-gateway.<account>.workers.dev/health"
# {"ok":true,"service":"cf-email-gateway"}
```

### SMTP selftest (needs `COMPOSE_API_TOKEN` + SMTP secrets)

```bash
export TOKEN='…'   # same value as COMPOSE_API_TOKEN secret
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://cf-email-gateway.<account>.workers.dev/v1/smtp-selftest?to=me@gmail.com"
```

Expect `ok: true`, `transport: "smtp"`.

### Compose

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  "https://cf-email-gateway.<account>.workers.dev/v1/compose" \
  -d '{
    "from": "me@example.com",
    "to": "me@gmail.com",
    "subject": "cf-email-gateway smoke",
    "text": "hello"
  }'
```

Requires `domains.example.com.send_as.enabled: true` (or your apex) in `ROUTING_YAML`.

### Inbound

Send mail to any address on the catch-all domain → expect:

- Message in `default_inbox` (cf_forward)  
- Optional X-CFEG-\* headers (Show original)  
- D1 row `status=completed` (and R2 object if `archive.enabled`)

```bash
npx wrangler d1 execute cf-email-gateway --remote --command \
  "SELECT envelope_to, status, datetime(received_at/1000,'unixepoch')
   FROM inbound_messages ORDER BY received_at DESC LIMIT 5"
```

---

## 10. Optional companion (reply UX)

Browser extension that turns Gmail Reply into `r+TOKEN@…` hops:

- Repo: [cfeg-reply-extension](https://github.com/reynhartono/cfeg-reply-extension)  
- Contract: [docs/15-x-cfeg-header-contract.md](./15-x-cfeg-header-contract.md)

Not required for archive/forward/compose/send-proxy.

---

## Secret checklist

| Secret | Required for |
|--------|----------------|
| `ROUTING_YAML` | All routing / tokens / send_as |
| `SMTP_HOST` | Compose, send-proxy, reply hop, smtp-selftest |
| `SMTP_USERNAME` | same |
| `SMTP_PASSWORD` | same |
| `SMTP_PORT` | optional (default 465) |
| `COMPOSE_API_TOKEN` | `/v1/compose`, `/v1/smtp-selftest` |

---

## Ops notes

| Topic | Detail |
|-------|--------|
| Config SoT | Secret `ROUTING_YAML` at runtime; example file is documentation only (no silent fallback — Q41) |
| Missing secret | Email throws; HTTP → 503; `/health` → `ok:true` + `routing_ok:false` |
| Deploy wipes | Dashboard **plain Text** Worker vars — use **secrets** |
| Worker name | Default `cf-email-gateway`; Email Routing action must match |
| Retries | B9: partial failure throws; CF retries; succeeded dests skipped |
| Privacy | Don’t commit real routing YAML, `.eml`, secrets, or account/D1 ids |

More detail: [02-config-and-routing.md](./02-config-and-routing.md), [06-ops.md](./06-ops.md), [12-providers.md](./12-providers.md), [17-send-proxy.md](./17-send-proxy.md).
