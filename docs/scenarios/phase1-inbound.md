# Phase 1 — Inbound (synthetic runbook)

**Zone under test:** `example.com` (catch-all → Worker).  
**Inbox:** `me@gmail.com` (CF Email Routing destination verified).  
**Addresses:** unique local-parts, e.g. `p1-b1-$(date +%s)@example.com`.

| Batch | Intent | Expect |
|-------|--------|--------|
| 1 | Mail → unique@example.com | D1 `completed`; cf_forward to me@gmail.com; R2 object |
| 2 | No default_inbox config | `ingested_only` if no rules |
| 3 | Multi dest | me@ + other@ both succeeded |
| 4 | One invalid dest | retryable fail; good dest succeeded |
| 5 | `special@example.com` rule | other@ + default me@ |
| 6 | archive off | completed without R2 |

Use fixtures under `test/scenarios/batch*.yaml` with `ROUTING_YAML`.
