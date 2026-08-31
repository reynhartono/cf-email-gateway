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

## D1 peek

```bash
npx wrangler d1 execute cf-email-gateway --remote --command \
  "SELECT envelope_to, status, last_error, datetime(received_at/1000,'unixepoch')
   FROM inbound_messages ORDER BY received_at DESC LIMIT 10"
```
