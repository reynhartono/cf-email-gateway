# 20 — Identities (multi-person compose / reply ACL)

## Goal

When several people share a privacy apex, each person may only:

| Path | Constraint |
|------|------------|
| **Compose** (`POST /v1/compose`) | Bearer → identity; `From` must be in that identity’s `can_send_as` |
| **Reply hop** (`r+TOKEN@`) | Sender Gmail → identity; token’s `our_mailbox` must be in `can_send_as` |
| **Send-proxy** | Same as compose From: alias must be in `can_send_as` |

Inbound **receive** routing stays rule-based (`local_part_prefix` / `address`); identities do not replace `rules`.

## Default route vs exceptions (insert-first)

**Default inbound route** is always normal delivery (`cf_forward` via rules / `default_inbox`) after D1 insert (+ archive).  
`r+TOKEN@` and `alias+user=domain@apex` are **address patterns** that may trigger an **exception** (hop / send-proxy). They are not exclusive early rejects.

| Shape | Exception (every gate passes) | Any gate fails |
|-------|-------------------------------|----------------|
| `r+TOKEN@…` | reply hop SMTP | **default cf_forward** (`reply_token.exception_skipped`) |
| `alias+user=domain@apex` | send-proxy SMTP | **default cf_forward** (`send_proxy.exception_skipped`) |
| accidental `me+someting=asdf.asd@…` | only if all proxy gates pass | still **arrives** via default_inbox / rules |

**Exception gates (all required before leaving the default path):** pattern match ∧ sender authorized ∧ identity bound ∧ `can_send_as` allows the proxy alias / token `our_mailbox` ∧ (reply: token exists + CF auth) ∧ (proxy: `send_as` resolve OK).

**Alice using Bob’s alias:** Alice is authorized, but mailbox ACL fails → **do not enter** hop/proxy → **default forward** (not reject, not send-as-Bob).

Defense-in-depth checks remain inside hop/proxy handlers if something calls them directly.

## Config

```yaml
identities:
  - id: alice
    authorized_from:
      - alice@gmail.com          # Gmail From for hop / send-proxy
    compose_bearer: "secret-alice-only"   # HTTP Bearer for compose (live ROUTING_YAML)
    can_send_as:
      - { type: local_part_prefix, value: "alice.", domain: example.com }
      - { type: address, value: alice@example.com }

  - id: bob
    authorized_from: [bob@gmail.com]
    compose_bearer: "secret-bob-only"
    can_send_as:
      - { type: local_part_prefix, value: "bob.", domain: example.com }

  - id: operator
    authorized_from: [me@gmail.com]
    unrestricted: true           # any send_as-enabled From / any token mailbox
    # COMPOSE_API_TOKEN maps here when identities are enabled
```

### Compose Bearer resolution

1. `Authorization: Bearer <identities[].compose_bearer>` → that identity  
2. Else `Bearer === COMPOSE_API_TOKEN` → first `unrestricted: true` identity  
3. Else 401  

If **`identities` is empty** (legacy): only `COMPOSE_API_TOKEN`; any `send_as` From allowed.

### Reply / send-proxy

- Allowlist = union of all `identities[].authorized_from` + legacy `token_auth.authorized_from`  
- If identities non-empty: sender must match an identity; then mailbox ACL applies  
- If identities empty: legacy allowlist only (any authorized sender may use any token / any alias)

## Pair with receive rules

```yaml
rules:
  - id: alice-ns
    skip_default_inbox: true
    match: { type: local_part_prefix, value: "alice.", domain: example.com }
    destinations: [{ email: alice@gmail.com }]
```

Receive prefix and `can_send_as` prefix should match so Alice only sees (and can reply as) her namespace.

### Outbound mailbox shapes (lock)

| Allowed for person `alice` | Denied |
|----------------------------|--------|
| `alice@example.com` (`type: address`) | `alicenetflix@example.com` (glue local — other user may own) |
| `alice+promo@example.com` (subaddress → bare) | `alice` prefix **without** trailing `.` (ignored / no match) |
| `alice.netflix@example.com` (`local_part_prefix` `alice.`) | `bob.…@example.com` |
| `alice.netflix+id@example.com` (subaddress → ns) | `r@example.com` / `r.…@` (reserved local) |
| `alice.anything@example.com` | proxy-shaped From `alice+user=domain@…` (not stripped for can_send_as) |

`local_part_prefix` in `can_send_as` uses the same trailing-`.` lock and **person-tag** subaddress normalize (`purpose: can_send_as`). Send-proxy-shaped From strings are **not** collapsed to bare alias for ACL.

## Security notes

- `compose_bearer` values live only in **private** deploy `ROUTING_YAML` (secret).  
- Knowing an `r+TOKEN` address is not enough when identities are on — hop From must own `our_mailbox`.  
- Operator `unrestricted` is intentional break-glass; keep its Gmails tight.  
- Archive remains shared under the operator.  
- With **`identities` empty** (legacy), any `token_auth.authorized_from` sender may send-proxy as **any** alias — enable identities for multi-person ACL.
- One Gmail on **multiple** identity rows is OK: inbound actor **merges** `can_send_as` (e.g. teddy + serafim for the same person).
