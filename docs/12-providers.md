# 12 — Providers

| Method | Role |
|--------|------|
| `cf_forward` | Inbound default — CF Email Routing forward + optional X-CFEG headers |
| `provider_send` / SMTP | Compose, send-proxy, reply hop via SMTP DATA |

Secrets: `SMTP_HOST`, `SMTP_USERNAME` (or `SMTP_USER`), `SMTP_PASSWORD` (or `SMTP_PASS`), optional `SMTP_PORT` (default 465), optional `SMTP_TLS` (`on` | `starttls` for rare ports).

TLS is fail-closed: 465/8465/443 → implicit TLS, 587/2525/8025 → STARTTLS. Any other port returns an error instead of connecting in plaintext unless `SMTP_TLS` is set explicitly.
