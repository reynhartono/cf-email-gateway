# 12 — Providers

| Method | Role |
|--------|------|
| `cf_forward` | Inbound default — CF Email Routing forward + optional X-CFEG headers |
| `provider_send` / SMTP | Compose, send-proxy, reply hop via SMTP DATA |

Secrets: `SMTP_HOST`, `SMTP_USERNAME` (or `SMTP_USER`), `SMTP_PASSWORD` (or `SMTP_PASS`), optional `SMTP_PORT` (default 465), optional `SMTP_TLS` (`on` | `starttls` for rare ports).

```bash
printf '%s' 'mail.example.com' | npx wrangler secret put SMTP_HOST
printf '%s' 'smtp-user'        | npx wrangler secret put SMTP_USERNAME
printf '%s' 'smtp-pass'        | npx wrangler secret put SMTP_PASSWORD
# optional:
# printf '%s' '465' | npx wrangler secret put SMTP_PORT
npx wrangler deploy
```

TLS is fail-closed: 465/8465/443 → implicit TLS, 587/2525/8025 → STARTTLS. Any other port returns an error instead of connecting in plaintext unless `SMTP_TLS` is set explicitly.

When set, `SMTP_TLS` takes precedence over the port default (e.g. `587` + `SMTP_TLS=on` forces implicit TLS on a submission port — only set it deliberately).

Breaking change: ports 25 and 80 now hard-error instead of connecting in plaintext. An internal plaintext-only relay on port 25 will break on upgrade — setting `SMTP_TLS` will not help unless the server actually speaks TLS on that port; move to a TLS-capable port (465/8465/443/587/2525/8025) instead.

## Outbound wire

All outbound (compose, send-proxy, reply hop) uses **SMTP DATA** over TCP:

```text
Worker → SMTP_HOST:SMTP_PORT (TLS)
  AUTH LOGIN
  MAIL FROM / RCPT TO
  DATA
  <exact MIME>
  .
```

Hop/proxy body is 1:1 MIME via SMTP DATA.

## Why not HTTP “send email” APIs?

Vendor HTTP MIME endpoints often **re-wrap** messages (drop HTML, new boundaries).
SMTP DATA keeps multipart/QP bodies **1:1**.
