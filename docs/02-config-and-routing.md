# 02 — Config and routing

SoT example: `config/routing.example.yaml`.  
Live: wrangler secret `ROUTING_YAML` (or gitignored local overlay).

## Shape

```yaml
version: 1
default_inbox: me@gmail.com
archive:
  enabled: true
compose:
  default_from: me@example.com
reply_tokens:
  enabled: true
defaults:
  provider: smtp
  send_as:
    enabled: false
    multiparty: true
token_auth:
  authorized_from:
    - me@gmail.com
domains:
  example.com:
    send_as:
      enabled: true
rules:
  - id: billing
    match: { type: address, value: billing@example.com }
    destinations:
      - email: finance@gmail.com
```

## resolve_driver

Inbound default: **`cf_forward`**.  
Explicit `provider_send` / `smtp` only when set on a destination (advanced).

## reply tokens (X-CFEG)

Global `reply_tokens.enabled` (default **true**) **and** envelope apex `domains.<apex>.send_as.enabled: true`.  
Archive-only Worker zones (send_as false) still **cf_forward** + archive; no `r+` / X-CFEG mint.

## default_inbox merge

On rule match, `default_inbox` is **always merged** (deduped) unless `skip_default_inbox: true`.

## Rule match types

Envelope `To` is lowercased. Tiers (higher always wins; YAML order only matters **within** a tier):

| Tier | `match.type` | Fields | Behavior |
|------|--------------|--------|----------|
| 1 | `address` | `value` = full addr | Exact envelope To |
| 2 | `local_part_prefix` | `value` = prefix, **`domain` required** | Local-part `startsWith(value)` on that apex |
| 2 | `local_part_plus` | `value` = user, **`domain` required** | `user@domain` or `user+tag@domain` (no `userX` bleed) |
| 3 | `catch_all` | optional `value` = apex | All remaining on that apex (or any if omitted) |
| 4 | — | — | `default_inbox` if set, else ingest-only |

### Prefix safety

- Prefer a **trailing separator** on prefixes (`alice.` or `alice+`) so `alice` does not match `alicesevil@…`.
- Put **longer / more specific** prefixes **before** shorter ones in YAML (first match in tier 2 wins).
- Empty `value` never matches.
- Multi-person / shared privacy domains: set **`skip_default_inbox: true`** on person rules or operator inbox is still merged.

### Multi-person privacy pattern (synthetic)

Person owns a local-part namespace on one apex — **not** per-person subdomains:

```yaml
rules:
  - id: alice-ns
    skip_default_inbox: true
    match:
      type: local_part_prefix
      value: "alice."
      domain: example.com
    destinations:
      - email: alice@gmail.com

  - id: bob-plus
    skip_default_inbox: true
    match:
      type: local_part_plus
      value: bob
      domain: example.com
    destinations:
      - email: bob@gmail.com

  - id: example-unknown
    skip_default_inbox: true
    match: { type: catch_all, value: example.com }
    destinations: []   # archive / ingest-only — do not spill to operator default_inbox
```

Addresses: `alice.netflix@example.com` → Alice; `bob+github@example.com` → Bob.  
See also `docs/19-multi-person-routing.md`.
