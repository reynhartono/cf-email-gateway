# 13 — Delivery and reply

## Inbound (default)

```text
insert → archive? → cf_forward → message.forward(dest, { headers: X-CFEG-* })
```

Do **not** rewrite MIME `Reply-To` (DKIM). Extension reads X-CFEG headers.

## Reply hop (exception)

```text
authorized From → r+TOKEN@ourdomain → SMTP From=our_mailbox → participant(s)
```

Only when pattern ∧ authorized (else default cf_forward).  
Auth: `token_auth.authorized_from` / identities + CF Authentication-Results pass (fail closed inside hop).

## Send-proxy (exception)

See [17-send-proxy.md](./17-send-proxy.md). Unauthorized or CF-auth-fail proxy-shaped To stays on default forward.  
Auth matches reply hop: allowlist / identities **+ CF Authentication-Results pass** (fail closed; MIME `From` alone is not enough).

## Body fidelity

Hop/proxy use `rebuildOutboundMime` + **SMTP DATA** (1:1 multipart/HTML).
