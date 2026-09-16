# 04 — Architecture

```text
Email Routing
    │
    ▼
Worker email() handler
    ├─ buffer message.raw once
    ├─ detect shapes (r+ / send-proxy) — flags only
    ├─ resolveDestinations → D1 insert → archive (B9)
    ├─ DEFAULT ROUTE: rules / default_inbox → cf_forward (+ X-CFEG mint)
    │     exceptions only when pattern ∧ authorized ∧ identity OK:
    │       ├─ r+ token  → reply hop → SMTP DATA
    │       └─ send-proxy → SMTP DATA (no default_inbox on success path)
    │     unauthorized pattern → stay on DEFAULT (cf_forward)
    └─

HTTP fetch()
    ├─ GET  /health              # entry only: { ok, service, routing_ok }
    ├─ POST /v1/compose          # requires ROUTING_YAML (else 503)
    └─ GET  /v1/smtp-selftest    # requires ROUTING_YAML (else 503)
```

Bindings: **D1** (`DB`), **R2** (`ARCHIVE`).  
Secrets: `ROUTING_YAML` (required), `SMTP_*`, `COMPOSE_API_TOKEN`.
