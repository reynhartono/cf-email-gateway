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
| 1 | `address` | `value` = full addr | Exact on **routing-normalized** local + domain |
| 2 | `local_part_prefix` | `value` = prefix, **`domain` required** | Normalized local-part `startsWith(value)` on that apex |
| 3 | `catch_all` | optional `value` = apex | All remaining on that apex (or any if omitted) |
| 4 | — | — | `default_inbox` if set, else ingest-only |

### Subaddress (plus-tag) normalize for match

For **rule evaluation only**, the local-part is passed through `normalizeLocalForRouting` (`purpose: rule_match`):

- Person tags: `alice+promo@…` → base `alice` (bare `address` hit); `alice.netflix+id1@…` → base `alice.netflix` → still `alice.` prefix.
- **Send-proxy-shaped** locals on the **default forward** path (including after `send_proxy.exception_skipped`): `alice+bob=gmail.com@…` → base `alice`; optional CFEG `{display}` after the alias is dropped the same way as `parseSendProxyAddress` (`alice{Bob}+bob=gmail.com@…` → `alice`) so exception-skip still hits person bare/prefix rules.
- Person tags (non-proxy): strip is **before the first `+` only** — never glue-concat toward `alicepromo`.
- **Do not strip** reply-token locals (`r+TOKEN…`) — Option A; hop `exception_skipped` must not invent bare `r@`.
- Shape detect + hop/proxy gates still use **raw** To. Successful hop/proxy SMTP is unchanged (no dual-delivery).
- Envelope To in D1 / logs / archive stays the **raw** address. Dedupe keeps raw To (do not merge `alice@` vs `alice+a@`).
- **Published multi-person aliases** stay `person@` and `person.service@` (dot namespace). Many site validators reject `+` in the *published* alias — that constraint remains; inbound still honors Gmail-style tags on those stable bases.
- Outbound `identities.can_send_as` uses person-tag strip only (`purpose: can_send_as`) — **does not** treat proxy-shaped From as bare alias.

### Reserved local `r`

The single-label local **`r`** is reserved for reply-token grammar (`r+TOKEN@apex`):

- Config load **rejects** bare `address` `r@…`, prefix `r.` / bare prefix `r`, `default_inbox` / `compose.default_from` of `r@…` / `r.…`, and matching `identities.can_send_as` entries.
- Runtime defense: rule match and `can_send_as` never honor slipped `r` / `r.` person hits.
- Operators must not publish person vanity `r@` or namespace `r.` on Worker-handled apexes (`ryan.` is fine).

### Prefix safety

- **`local_part_prefix` requires a trailing `.`** on `value` (`alice.`). Without it the rule never matches (hard lock).
- That lock stops glue-local bleed: `alice.` matches `alice.netflix@…` and **not** `alicenetflix@…` (another person may own the glued local).
- Bare vanity is **`match.type: address`** only (`alice@apex`) — prefix alone never covers bare local.
- Put **longer / more specific** prefixes **before** shorter ones in YAML (first match in tier 2 wins).
- Empty `value` never matches.
- Multi-person / shared privacy domains: set **`skip_default_inbox: true`** on person rules or operator inbox is still merged.
- **Outbound** (compose / send-proxy / reply hop): same bare + `person.` shapes via `identities[].can_send_as` — see `docs/20-identities.md`.

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

  - id: bob-ns
    skip_default_inbox: true
    match:
      type: local_part_prefix
      value: "bob."
      domain: example.com
    destinations:
      - email: bob@gmail.com

  - id: example-unknown
    skip_default_inbox: true
    match: { type: catch_all, value: example.com }
    destinations: []   # archive / ingest-only — do not spill to operator default_inbox
```

Addresses: `alice.netflix@example.com` → Alice; `bob.github@example.com` → Bob.  
Bare vanity `alice@example.com` needs a separate `address` rule (prefix `alice.` does not match it).  
See also `docs/19-multi-person-routing.md`.
