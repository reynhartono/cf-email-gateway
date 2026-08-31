# 04 — Architecture

```text
Email Routing
    │
    ▼
Worker email() handler
    ├─ buffer message.raw once
    ├─ r+ token?     → reply hop → SMTP DATA
    ├─ send-proxy?   → SMTP DATA (no cf_forward)
    └─ normal
         ├─ archive → R2 (B9)
         ├─ mint X-CFEG token (optional)
         └─ cf_forward (+ X-CFEG headers)

HTTP fetch()
    ├─ GET  /health
    ├─ POST /v1/compose
    └─ GET  /v1/smtp-selftest
```

Bindings: **D1** (`DB`), **R2** (`ARCHIVE`).  
Secrets: `ROUTING_YAML`, `SMTP_*`, `COMPOSE_API_TOKEN`.
