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

## default_inbox merge

On rule match, `default_inbox` is **always merged** (deduped) unless `skip_default_inbox: true`.
