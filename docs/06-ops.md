# 06 — Ops

Day-2 notes. **First-time install:** [18-installation.md](./18-installation.md).

## Update routing or SMTP

```bash
npx wrangler secret put ROUTING_YAML < config/routing.local.yaml
printf '%s' 'mail.example.com' | npx wrangler secret put SMTP_HOST
# … SMTP_USERNAME / SMTP_PASSWORD / COMPOSE_API_TOKEN as needed
npx wrangler deploy
```

## Selftests

```bash
# Bearer COMPOSE_API_TOKEN
curl -sS -H "Authorization: Bearer $COMPOSE_API_TOKEN" \
  "https://cf-email-gateway.<account>.workers.dev/v1/smtp-selftest?to=me@gmail.com"
```

## After every secret put

Redeploy. Dashboard plain Text env is wiped by `wrangler deploy`.

## ROUTING_YAML required (Q41)

- Live Worker **must** have non-empty secret `ROUTING_YAML`. There is no silent use of `routing.example.yaml`.
- `GET /health` returns `routing_ok: true` only when config loads (secret present + parseable, or explicit `ALLOW_EXAMPLE_ROUTING` for local dev).
- `routing_ok: false` → put secret + redeploy before expecting mail/compose to work.
- Empty secret / wipe / first boot without `secret put` → inbound throws; compose/selftest **503**.

## D1 peek

```bash
npx wrangler d1 execute cf-email-gateway --remote --command \
  "SELECT envelope_to, status, last_error, datetime(received_at/1000,'unixepoch')
   FROM inbound_messages ORDER BY received_at DESC LIMIT 10"
```
