# 19 — Multi-person privacy routing

## Goal

Share one catch-all apex (privacy mail domain) among several people without:

- Per-person **subdomains** (extra MX / Email Routing / DKIM surface)
- Silently copying everyone into the operator `default_inbox`

## Recommendation

| Choice | Decision |
|--------|----------|
| Namespace | **Local-part on apex** (`person.service@domain`) |
| Not default | Subdomain per person (`@person.domain`) |
| Match | `local_part_prefix` + exact `address` as needed |
| Isolation | `skip_default_inbox: true` on every person rule |
| Unknowns | Domain-scoped `catch_all` → ingest-only or explicit ops mailbox — **not** operator default merge |
| Reply / send-proxy | Apex `send_as.enabled`; each sender in `token_auth.authorized_from` |
| Archive | Still **shared** R2/D1 under the operator — not end-to-end multi-tenant isolation |
| Avoid as **published** alias | `person+service@` — many validators reject plus-addressing; use dot namespace instead |
| Inbound tags OK | `alice+promo@` / `alice.netflix+id@` strip to base for **rule match only** (raw To kept in D1) |

## Addressing conventions

| Style | Example | Matcher |
|-------|---------|---------|
| Person + dot service | `alice.netflix@example.com` | `local_part_prefix` `value: "alice."` |
| Vanity exact | `alice@example.com` | `address` (prefix `alice.` does **not** match bare `alice@`) |
| Subaddress on bare | `alice+promo@example.com` | same bare `address` after normalize |
| Subaddress on ns | `alice.netflix+id1@example.com` | same `alice.` prefix after normalize |
| Glue (denied) | `alicenetflix@example.com` | no match on `alice.` |

Prefer stable handles (`alice.`) over single-letter (`a.`) unless the set is tiny and fixed.

## Rule tier reminder

`address` → `local_part_prefix` → `catch_all` → `default_inbox`  
(see `docs/02-config-and-routing.md`).

## Operator checklist

1. Verify each real destination in Cloudflare Email Routing.  
2. Person rules: destinations + **`skip_default_inbox: true`**.  
3. Optional exact vanity addresses for bare `person@apex`.  
4. Apex `catch_all` policy for unknowns.  
5. `authorized_from` only for people allowed to hop / send-proxy (or bind via `identities`).  
6. For compose + hop isolation, add `identities` with matching `can_send_as` prefixes — `docs/20-identities.md`.  
7. Tell participants: archive is operator-hosted; aliases are privacy vs third parties, not vs the operator.
