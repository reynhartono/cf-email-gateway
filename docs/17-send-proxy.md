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

## Auth

- Sender ∈ `token_auth.authorized_from` / identities (else **default forward**, not open relay).  
- **CF Authentication-Results aligned pass** (same fail-closed gate as reply hop via `cfAuthLooksPass` — method=pass **and** domain alignment to the authorized From; prefer Cloudflare authserv). MIME `From` alone is spoofable — without an aligned CF auth pass the Worker stays on **default `cf_forward`** and logs `send_proxy.exception_skipped` with reason `cf_auth_failed`.  
- When identities are set, `alias@domain` must be in that identity’s `can_send_as` (else fail-closed ACL).  
- `alias@domain` needs `domains.<domain>.send_as.enabled` + ESP-verified domain.  
- Authorized success path is **proxy-only** (no dual-delivery to default_inbox).

Do **not** treat raw MIME `From` matching the allowlist as proof of mailbox control. Envelope/header allowlist match is necessary but not sufficient without CF auth (or `hooks.skipCfAuth` in tests only).
