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

- Live Worker **must** have non-empty secret `ROUTING_YAML`. Example YAML is never imported into the Worker bundle.
- **After every deploy / pin:** confirm live `GET /health` shows `"routing_ok": true` **before** relying on Email Routing. Until then inbound throws (CF may retry) — intended fail-closed, not silent example policy.
- `routing_ok: false` → put secret + redeploy; do not expect mail/compose to work.
- Empty secret / wipe / first boot without `secret put` → inbound throws; compose/selftest **503**.
- `GET /health` is handled only at the Worker entry (`src/index.js`); it stays up with `ok: true` even when routing is missing so probes can distinguish process-up vs config-ok.

## D1 peek

```bash
npx wrangler d1 execute cf-email-gateway --remote --command \
  "SELECT envelope_to, status, last_error, datetime(received_at/1000,'unixepoch')
   FROM inbound_messages ORDER BY received_at DESC LIMIT 10"
```
