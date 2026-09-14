# 09 — Decisions & defaults

**Product SoT.** Sync `AGENTS.md` when changing.  
Author PII → gitignored `config/routing.local.yaml` / `docs/author-fleet.local.md`.

## Locked

| # | Topic | Default |
|---|--------|---------|
| Q1 | Name | `cf-email-gateway` |
| Q2 | archive.enabled | `true` |
| Q3 / B9 | Archive + delivery | Deliver same run even if R2 fails; **SUCCESS only if archive_ok ∧ delivery_ok**; else THROW |
| Q4 | Inbound delivery | **`cf_forward` only** (+ X-CFEG tokens) |
| Q5 | Domain allowlist | No — unlisted still gateway |
| Q6–8 | Tokens | On cf_forward; never ESP as Alice; token auth fail-closed |
| Q9 | Config | YAML + wrangler secrets |
| Q13 | Retention | Deferred |
| B6 | Token TTL | None (rows until manual delete / future cleanup) |
| Q14–16 | send_as | Outbound From gate; default false |
| Q17 | License | **MIT** |
| Q19–21 | default_inbox | Always merged on rule match unless skip |
| B10 | Git hygiene | Examples + synthetic fixtures only; live routing/secrets/ids stay out of commits |
| B15 | Dual-delivery | Rejected |
| Q22 | Multi-person privacy domain | Apex local-part namespaces — not per-person subdomains |
| Q23 | Rule match tiers | `address` → `local_part_prefix` → `catch_all` → default_inbox |
| Q24 | local_part_prefix | `value` + required `domain`; empty prefix never matches; prefer trailing separator (e.g. `alice.`) |
| Q25 | Plus-addressing | **Not supported** as a first-class match type — many site validators reject `+` |
| Q26 | Person rules | `skip_default_inbox: true`; shared apex unknowns should not silently use operator default_inbox |
| Q27 | Shared archive | Multi-person aliases still one operator archive (R2/D1) — not tenant isolation |
| Q28 | identities | Optional; when set, compose/reply/send-proxy enforce mailbox ownership (`can_send_as`) |
| Q29 | compose_bearer | Per-identity HTTP Bearer in ROUTING_YAML; COMPOSE_API_TOKEN → unrestricted identity only |
| Q30 | Reply hop ACL | Token usable only if sender identity may send as `reply_routes.our_mailbox` |


## Not open

- Dual-delivery default  
- KV as config SoT  
- ESP as Alice  
- SUCCESS without archive when archive.enabled  
- MIME Reply-To rewrite on forward (use X-CFEG)  
- Per-person subdomain routing as the default multi-person design  
- End-to-end archive isolation between people on one Worker  
- First-class `local_part_plus` / plus-tag alias matchers  
- Cross-identity token hop when identities are configured  
