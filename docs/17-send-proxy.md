# 17 — Send-proxy

Hide-my-email **style send** without the HTTP compose API:

1. From your **authorized** mailbox (e.g. Gmail in `token_auth.authorized_from` / identities)  
2. To a special address on **your domain** (catch-all → **Worker**)  
3. Gateway sends via SMTP as **alias@yourdomain** to the real recipient  
4. On **success path only**: does **not** also `cf_forward` to `default_inbox` (exception route)

## Default vs exception

Inbound **default** is always normal forward (rules / `default_inbox`).  
Send-proxy is an **exception**: it runs only when the To address matches the proxy shape **and** the sender is authorized (and identity-bound when `identities` are set).

If the To address merely *looks* like a proxy (e.g. `me+someting=asdf.asd@yourdomain`) but the sender is **not** authorized, the Worker keeps the **default route**: D1 insert + `cf_forward` — no open relay, no blackhole.

## Address format

```text
{alias}{optional display}+{recipient_local}{optional display}={recipient_domain}@{your_domain}
```

### Examples

```text
me+friend=gmail.com@example.com
  From (ESP): me@example.com
  To:         friend@gmail.com

shops{My_Shop}+alice=gmail.com@example.com
  From: "My Shop" <shops@example.com> → alice@gmail.com
```

Inside `{…}` use `_` = space (`__` = literal `_`).

### Default display without braces (Q42)

When braces are **omitted**, From display is resolved in order:

1. Optional **`display_name` on a matching rule** (`address`, then `local_part_prefix`)  
2. Optional **`domains.<apex>.display_name`** (whole-domain default)  
3. Optional **`defaults.display_name`**  
4. Bare address  

```yaml
domains:
  example.com:
    send_as: { enabled: true }
    display_name: Example Co
rules:
  - id: shops-bare
    match: { type: address, value: shops@example.com }
    display_name: Shop Support   # optional; wins over domain default
    destinations:
      - email: me@gmail.com
  - id: alice-person-ns
    match: { type: local_part_prefix, value: "alice.", domain: example.com }
    display_name: Alice           # optional; covers alice.netflix@…
    destinations:
      - email: alice@gmail.com
```

Then `shops+alice=gmail.com@example.com` → `From: "Shop Support" <shops@example.com>`.  
A mailbox with no rule name (or a rule without `display_name`) uses the domain default.  
Explicit `{…}` braces always override. Same lookup on **reply hop**. No separate top-level aliases map.

## Auth

- **Envelope From** ∈ `token_auth.authorized_from` / identities (else **default forward**, not open relay). MIME `From` is **not** used for send-proxy allowlist.  
- **CF Authentication-Results aligned pass on that same envelope identity** (shared `cfAuthLooksPass` with reply hop — Cloudflare authserv only via `isCloudflareAuthservId` / `*.cloudflare.net`, not substring; method=pass **and** domain alignment). Attacker envelope with real AR + spoofed allowlisted MIME From must **not** enter proxy.  
- When identities are set, `alias@domain` must be in that identity’s `can_send_as` (else fail-closed ACL).  
- `alias@domain` needs `domains.<domain>.send_as.enabled` + ESP-verified domain.  
- Authorized success path is **proxy-only** (no dual-delivery to default_inbox).

Do **not** treat raw MIME `From` matching the allowlist as proof of mailbox control. Envelope allowlist + CF auth on envelope are both required (or `hooks.skipCfAuth` in tests only).
