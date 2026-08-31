# 13 — Delivery and reply

## Inbound

```text
cf_forward → message.forward(dest, { headers: X-CFEG-* })
```

Do **not** rewrite MIME `Reply-To` (DKIM). Extension reads X-CFEG headers.

## Reply hop

```text
authorized From → r+TOKEN@ourdomain → SMTP From=our_mailbox → participant(s)
```

Auth: `token_auth.authorized_from` + CF Authentication-Results pass (fail closed).

## Send-proxy

See [17-send-proxy.md](./17-send-proxy.md).

## Body fidelity

Hop/proxy use `rebuildOutboundMime` + **SMTP DATA** (1:1 multipart/HTML).
