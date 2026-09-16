# AGENTS.md — cf-email-gateway

## Phase

**Phase 2 complete:** archive B9, compose, send-proxy, **cf_forward + X-CFEG v2**, reply hop via SMTP DATA.  
Extension polish is companion repo `cfeg-reply-extension`.

- Phase 1: archive B9, D1 attempts, **cf_forward**.  
- Phase 2a: compose + send-proxy; `FEATURES.provider_send = true`.  
- Phase 2b: inbound **cf_forward + X-CFEG-* v2**; reply hop SMTP 1:1.  


## SoT order

1. `docs/09-decisions.md`  
2. `docs/01` + `02` + `13` + **`15-x-cfeg-header-contract`**  
3. `docs/03` + `05`  
4. `docs/12` + `04` + `16` + `17`  
5. `docs/README.md` + this file + root `README.md`  
6. `src/` implements the above  

## Invariants

1. Archive optional; when on: deliver same run even if R2 fails; **SUCCESS only if archive_ok ∧ required dests ok**; else THROW; retry skips succeeded dests / retries archive.  
2. Pluggable delivery; zero dests = ingest-only.  
3. Inbound default **cf_forward** + X-CFEG tokens; compose/send-proxy/reply hop outbound **SMTP** our domain only. Never ESP as third-party sender.  
4. Dual-delivery rejected.  
5. MailProvider port; SMTP adapter only.  
6. delivery_targets + delivery_attempts.  
7. Partial dest failure → THROW; retry unfinished only.  
8. Config = git example YAML (docs only) + wrangler **secret** `ROUTING_YAML` required at runtime (no silent example fallback; Q41).  
9. No secrets/PII/real .eml / owner domains in git — synthetic `example.com` / `me@gmail.com` only.  
10. Name: cf-email-gateway.  

## Commands

```bash
npm test
npm run check
# wrangler d1 migrations apply cf-email-gateway --remote
# wrangler secret put ROUTING_YAML < config/routing.local.yaml
# wrangler deploy
```
