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

## Clean-room

Implement from **our docs + public APIs**. Inspiration from AGPL projects is ideas-only — **no code copy**.

## Not open

- Dual-delivery default  
- KV as config SoT  
- ESP as Alice  
- SUCCESS without archive when archive.enabled  
- MIME Reply-To rewrite on forward (use X-CFEG)  
