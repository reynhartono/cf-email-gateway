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
Auth: `token_auth.authorized_from` / identities **+** CF Authentication-Results **aligned pass** on the **envelope From** (fail closed inside hop). MIME `From` is not used for hop/proxy allowlist or CF auth (spoofable).

`cfAuthLooksPass` (shared with send-proxy) requires a Cloudflare authserv `Authentication-Results` / ARC line whose authserv-id is `cloudflare.net` or a DNS-label under `.cloudflare.net` (typically `mx.cloudflare.net`; Email Routing injects these). Substring spoofs (`notcloudflare.net`, `cloudflare.evil`) and client-only AR fail closed. Aligned `dkim` / `spf` / `dmarc` **pass** must match the **envelope** identity being authorized. Gmail envelope must align to the google/gmail ecosystem (Q39 / issue #7 / #13). Domain alignment is relaxed (subdomain OK).

Authserv allowlist alone is not enough when several Cloudflare-looking lines exist (issue #22): a client-supplied `Authentication-Results: mx.cloudflare.net; …pass…` preserved next to Email Routing's own evaluation must not authorize. Every Cloudflare-looking line that mentions the envelope identity must itself carry an aligned pass — any such line without one (fail / none / softfail) vetoes, order-independently. Lines that do not mention the identity are ignored.

## Send-proxy (exception)

See [17-send-proxy.md](./17-send-proxy.md). Unauthorized or CF-auth-fail proxy-shaped To stays on default forward.  
Auth matches reply hop: allowlist / identities **+ CF Authentication-Results pass** (fail closed; MIME `From` alone is not enough).

## Body fidelity

Hop/proxy use `rebuildOutboundMime` + **SMTP DATA** (1:1 multipart/HTML).
