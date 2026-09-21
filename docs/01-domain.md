# 01 — Domain model

## What the Worker does

1. **Receive** every message Email Routing sends to it (no domain allowlist).  
2. Optionally **archive** full MIME → R2.  
3. **Default deliver** via `cf_forward` (rules / `default_inbox`) with optional X-CFEG reply tokens.  
4. **Exception routes** (opt-in): compose HTTP, send-proxy, reply hop — outbound SMTP on operator domains when the sender is authorized.

## Core entities

| Entity | Notes |
|--------|--------|
| Inbound message | Dedupe by Message-ID (else + raw hash) |
| Destination | email + method (`cf_forward` \| `provider_send`) |
| Delivery attempt | Per target, retry unfinished only |
| Reply route | `r+TOKEN` → participants |
| Routing config | YAML version 1 |

## Inbound pipeline (default = forward)

**Contract:** every message is recorded (D1) and archived when configured **before** any special-route decision.  
**Default route** is always normal inbound delivery (`cf_forward` via rules / `default_inbox` / ingest-only).  
**Reply hop and send-proxy are exceptions** — they run only when the envelope **looks like** that pattern **and** the sender is authorized + identity-bound. Otherwise the same message stays on the default forward path (never blackholed).

```text
1. Buffer raw; parse envelope / headers
2. Detect shapes only (flags): r+TOKEN@… , alias+user=domain@apex
3. resolveDestinations (rules / default_inbox)
4. Dedupe → insert inbound → archive (B9) if wanted
5. Exception? (pattern ∧ authorized ∧ identity OK)
     ├─ r+TOKEN@…     → reply hop (SMTP)          [exception]
     └─ alias+user=…  → send-proxy (SMTP)         [exception]
   else → stay on default route (log *_unauthorized_fallback if shape matched)
6. Default route:
     6a. no destinations → ingested_only
     6b. else ensureTargets + mint X-CFEG once per inbound (reuse on dedupe) + cf_forward
        match tiers for destinations:
          address → local_part_prefix → catch_all → default_inbox
```

Multi-person privacy on one apex: local-part namespaces + `skip_default_inbox` — `docs/19-multi-person-routing.md`.  
Identities / ACL: `docs/20-identities.md`.

## send_as

`domains.<apex>.send_as.enabled` gates **outbound** From on that apex (compose, send-proxy, reply hop) and X-CFEG mint on forward.  
It does **not** change the default inbound driver (`cf_forward` unless a destination method is explicit).
