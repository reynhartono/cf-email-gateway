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
| Q25 | Plus-addressing as **published** alias | **Not** a first-class multi-person scheme (`person+service@`) — many site validators reject `+`; use bare + `person.` |
| Q26 | Person rules | `skip_default_inbox: true`; shared apex unknowns should not silently use operator default_inbox |
| Q27 | Shared archive | Multi-person aliases still one operator archive (R2/D1) — not tenant isolation |
| Q28 | identities | Optional; when set, compose/reply/send-proxy enforce mailbox ownership (`can_send_as`) |
| Q29 | compose_bearer | Per-identity HTTP Bearer in ROUTING_YAML; COMPOSE_API_TOKEN → unrestricted identity only |
| Q30 | Reply hop ACL | Token usable only if sender identity may send as `reply_routes.our_mailbox` |
| Q31 | Inbound default | **cf_forward** (rules / default_inbox) after insert+archive; hop/proxy are **exceptions** only |
| Q32 | Pattern shapes | `r+` / send-proxy To shapes are advisory; incomplete gates → stay on default forward (no outer reject blackhole) |
| Q33 | Insert-first | D1 (+ archive) before special-route authz; every message leaves a row when insert succeeds |
| Q34 | Exception entry | Hop/proxy only when **all** gates pass (auth + identity + can_send_as + token/resolve); Alice≠Bob alias → default forward |
| Q35 | Inbound subaddress | Strip `+tag` for **rule match** on person tags **and** send-proxy-shaped locals after exception-skip (`alice+bob=gmail.com` → `alice`; CFEG `{display}` dropped like proxy parse: `alice{Name}+…` → `alice`); **never strip `r+…`** (Option A); raw To in D1/logs |
| Q36 | can_send_as + tags | Person-tag strip on outbound From / hop mailbox; **do not** strip send-proxy-shaped From; unrestricted unchanged; dedupe still raw To |
| Q37 | Reserved local `r` | Bare `r@` **and** address `r.…@` / prefix `r.` forbidden on rules, `identities.can_send_as`, `default_inbox`, `compose.default_from` (aligned with `isReservedPersonLocal`); runtime defense if config slips |
| Q38 | Send-proxy CF auth | Same CF Authentication-Results fail-closed gate as reply hop (`cfAuthLooksPass`); spoofed MIME `From` alone must not enter send-proxy SMTP → default forward + `cf_auth_failed` |
| Q39 | CF auth alignment | `cfAuthLooksPass` requires Cloudflare authserv (`cloudflare.net` or `*.cloudflare.net` via `isCloudflareAuthservId` — not `/cloudflare/i` substring) + method=pass **and** domain alignment to the authorized identity (DKIM `header.d`/`i`, SPF `smtp.mailfrom`, DMARC `header.from`); Gmail narrows to google/gmail domains — never `\|\| hasPass`; client-only / spoofed authserv AR fails closed |
| Q40 | Exception identity = envelope | Hop/proxy allowlist + actor + CF auth use **envelope From only** (not MIME From, not envelope∨header). Cross-signal attack (attacker envelope + real AR + spoofed allowlisted From) → default forward |
| Q41 | ROUTING_YAML required | Non-empty secret is runtime SoT; **no fallback** and **no Worker import** of `routing.example.yaml` (docs/copy-paste only). Missing/empty/unparsable → email throws, HTTP non-health → **503**. `/health` stays up with `routing_ok`. Local DX: put YAML in `.dev.vars` / secret as `ROUTING_YAML` |
| Q42 | Alias From display name | Optional **`display_name` on the existing inbound rule** for that alias (usually `match.type: address`). Used as MIME From on **send-proxy** when `{aliasDisplay}` braces are absent, and on **reply hop** for `our_mailbox` / resolved mailFrom. Match tiers for lookup: address → `local_part_prefix` (prefix name covers `person.service@`); **catch_all ignored**. Explicit braces always win. Missing field = bare address. Compose HTTP keeps optional `from_name` only. No separate top-level aliases map. |


## Not open

- Dual-delivery default  
- KV as config SoT  
- ESP as Alice  
- SUCCESS without archive when archive.enabled  
- MIME Reply-To rewrite on forward (use X-CFEG)  
- Per-person subdomain routing as the default multi-person design  
- End-to-end archive isolation between people on one Worker  
- First-class `local_part_plus` / plus-tag **published multi-person** alias matchers (inbound tag strip on stable bare/prefix is Q35)  
- Cross-identity token hop when identities are configured  
- Authz-before-insert / exclusive early-return on r+ or proxy parse (blackholes accidental `+user=domain` To)  
- Stripping **reply-token** (`r+…`) locals on hop skip (Option A — would invent bare `r@`)  
- Dual-delivery on successful hop/proxy exception  
- Merging dedupe keys across `alice@` vs `alice+tag@`  
- Publishing person / vanity mailbox bare `r@` or namespace `r.` on Worker-handled apexes  
- Silent load / Worker import of bundled `routing.example.yaml` when `ROUTING_YAML` is missing (Q41)  
