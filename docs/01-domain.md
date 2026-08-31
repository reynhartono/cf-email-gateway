# 01 — Domain model

## What the Worker does

1. **Receive** every message Email Routing sends to it (no domain allowlist).  
2. Optionally **archive** full MIME → R2.  
3. **Deliver** via `cf_forward` (default) with optional X-CFEG reply tokens.  
4. **Compose / send-proxy / reply hop** outbound via SMTP on operator domains.

## Core entities

| Entity | Notes |
|--------|--------|
| Inbound message | Dedupe by Message-ID (else + raw hash) |
| Destination | email + method (`cf_forward` \| `provider_send`) |
| Delivery attempt | Per target, retry unfinished only |
| Reply route | `r+TOKEN` → participants |
| Routing config | YAML version 1 |

## Inbound routing priority

```text
1. r+TOKEN[.pN|.all]@domain  → reply hop
2. alias+user=domain@our     → send-proxy (no default_inbox)
3. rules / default_inbox / ingest-only
```

## send_as

`domains.<apex>.send_as.enabled` gates **outbound** From on that apex (compose, send-proxy, reply hop).  
It does **not** change inbound delivery (always `cf_forward` unless destination method is explicit).
