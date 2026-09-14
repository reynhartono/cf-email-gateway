# 00 — Glossary

| Term | Meaning |
|------|---------|
| **cf_forward** | Cloudflare Email Routing `message.forward` to a verified destination |
| **X-CFEG-*** | Custom headers on forwarded mail carrying reply-token hops (contract version **2**) |
| **reply hop** | Inbound to `r+TOKEN@ourdomain` → SMTP to original participant(s) |
| **send-proxy** | Authorized sender → `alias+user=domain@our` → SMTP as `alias@our` |
| **compose** | HTTP `POST /v1/compose` → SMTP From our domain |
| **default_inbox** | Fallback destination merged on rule match (unless skip) |
| **local_part_prefix** | Rule match: local-part starts with `value` on required `domain` |
| **B9** | Archive + delivery same run; SUCCESS only if both required paths ok |
| **ROUTING_YAML** | Wrangler secret holding live routing config |
