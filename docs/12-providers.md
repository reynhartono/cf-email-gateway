# 12 — Providers

| Method | Role |
|--------|------|
| `cf_forward` | Inbound default — CF Email Routing forward + optional X-CFEG headers |
| `provider_send` / SMTP | Compose, send-proxy, reply hop via SMTP DATA |

Secrets: `SMTP_HOST`, `SMTP_USERNAME` (or `SMTP_USER`), `SMTP_PASSWORD` (or `SMTP_PASS`), optional `SMTP_PORT` (default 465).
