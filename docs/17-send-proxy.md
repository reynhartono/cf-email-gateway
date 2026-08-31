# 17 — Send-proxy

Hide-my-email **style send** without the HTTP compose API:

1. From your **authorized** mailbox (e.g. Gmail in `token_auth.authorized_from`)  
2. To a special address on **your domain** (catch-all → **Worker**)  
3. Gateway sends via SMTP as **alias@yourdomain** to the real recipient  
4. **Does not** `cf_forward` to `default_inbox`

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

- Sender ∈ `token_auth.authorized_from` (else **reject**, no open relay).  
- `alias@domain` needs `domains.<domain>.send_as.enabled` + ESP-verified domain.  
- Path is **proxy-only**.
