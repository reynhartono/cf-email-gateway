# 16 — Outbound SMTP

All outbound (compose, send-proxy, reply hop) uses **SMTP DATA** over TCP.

```text
Worker → SMTP_HOST:SMTP_PORT (TLS)
  AUTH LOGIN
  MAIL FROM / RCPT TO
  DATA
  <exact MIME>
  .
```

## Secrets

```bash
printf '%s' 'mail.example.com' | npx wrangler secret put SMTP_HOST
printf '%s' 'smtp-user'        | npx wrangler secret put SMTP_USERNAME
printf '%s' 'smtp-pass'        | npx wrangler secret put SMTP_PASSWORD
# optional:
# printf '%s' '465' | npx wrangler secret put SMTP_PORT
npx wrangler deploy
```

## Why not HTTP “send email” APIs?

Vendor HTTP MIME endpoints often **re-wrap** messages (drop HTML, new boundaries).  
SMTP DATA keeps multipart/QP bodies **1:1**.
