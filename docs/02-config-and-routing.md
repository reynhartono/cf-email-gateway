# 02 — Config and routing

SoT example (docs / copy-paste only): `config/routing.example.yaml`.  
**Live runtime SoT:** non-empty wrangler secret `ROUTING_YAML` (from a gitignored local file).  

Missing, empty, or unparsable `ROUTING_YAML` **fails closed** (Q41): inbound email throws; HTTP compose/selftest returns **503**. `/health` stays up and reports `routing_ok: false`. The Worker does **not** import or fall back to the example file — not even behind a flag.  

Local DX: copy the example into `.dev.vars` / a local secret as `ROUTING_YAML` (same path as production).

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
    display_name: Billing   # optional (Q42) — outbound From display
    destinations:
      - email: finance@gmail.com
  - id: alice-bare
    skip_default_inbox: true
    match: { type: address, value: alice@example.com }
    display_name: Alice
    destinations:
      - email: alice@gmail.com
```

## rule / domain `display_name` (From display)

Optional strings for outbound MIME `From` when the operator did not supply a per-message name. **Everything here is optional** — omit all → bare address (previous behavior).

```yaml
defaults:
  # display_name: Family   # optional global fallback
domains:
  example.com:
    send_as: { enabled: true }
    display_name: Example Co   # domain default if no rule name
rules:
  - id: alice-bare
    skip_default_inbox: true
    match: { type: address, value: alice@example.com }
    display_name: Alice           # optional; wins for alice@ / alice+tag@
    destinations:
      - email: alice@gmail.com
  - id: alice-person-ns
    skip_default_inbox: true
    match: { type: local_part_prefix, value: "alice.", domain: example.com }
    display_name: Alice           # optional; wins for alice.netflix@ etc.
    destinations:
      - email: alice@gmail.com
  - id: shops
    match: { type: address, value: shops@example.com }
    # no display_name → domain / defaults / bare
    destinations:
      - email: me@gmail.com
```

| Path | Precedence |
|------|------------|
| Send-proxy with `{aliasDisplay}` braces | Braces win |
| Send-proxy without braces / reply hop | See lookup tiers |
| Compose HTTP | Unchanged — optional JSON `from_name` / `fromName` only |

**Lookup tiers** (first hit with a non-empty name):

1. **`match.type: address`** rule for the mailbox (subaddress-normalized)  
2. **`match.type: local_part_prefix`** rule (e.g. `alice.` → `alice.netflix@`)  
3. **`domains.<apex>.display_name`** — whole-domain default when no rule name  
4. **`defaults.display_name`** — global fallback  

**`catch_all` rules are ignored** for From display. A matched address/prefix rule **without** `display_name` does not block fallthrough to domain/defaults. Values cannot contain header control characters.

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

- Config load **rejects** `address` locals in the full reserved set (`r@…` **and** `r.…@…`), prefix `r.` / bare prefix `r`, `default_inbox` / `compose.default_from` of `r@…` / `r.…`, and matching `identities.can_send_as` entries (same predicate as runtime `isReservedPersonLocal`).
- Runtime defense: rule match and `can_send_as` never honor slipped `r` / `r.` person hits.
- Operators must not publish person vanity `r@` or namespace `r.` on Worker-handled apexes (`ryan.` is fine).

### Prefix safety

- **`local_part_prefix` requires a trailing `.`** on `value` (`alice.`). Without it the rule never matches (hard lock).
- That lock stops glue-local bleed: `alice.` matches `alice.netflix@…` and **not** `alicenetflix@…` (another person may own the glued local).
- Bare vanity is **`match.type: address`** only (`alice@apex`) — prefix alone never covers bare local.
- Put **longer / more specific** prefixes **before** shorter ones in YAML (first match in tier 2 wins).
- Empty `value` never matches.
- Multi-person / shared privacy domains: set **`skip_default_inbox: true`** on person rules or operator inbox is still merged.
- **Outbound** mailbox shapes (compose / send-proxy / reply hop) are SoT in [20-identities.md](./20-identities.md) (`can_send_as`, same trailing-`.` lock, glue/reserved denies).

### Multi-person privacy pattern

SoT: [19-multi-person-routing.md](./19-multi-person-routing.md) (namespaces, rule pairs, catch_all policy) + [20-identities.md](./20-identities.md) (outbound ACL). This doc owns match tiers + normalize only — do not add person tables here.
