# 14 — Risks & known issues

## Future improvement — dedupe collision (KI)

**Current:** Message-ID present → dedupe = `sha256(from+to+normalized mid)` (ignores raw).  
**Risk:** Two *different* mails with the same from/to/Message-ID merge into one inbound (retry semantics).  
**Accept for now** (retry idempotency > rare mid reuse).  
**Later:** optional window, secondary raw check, or freeze-first-hash hybrid — see batch4 live notes.

## Accepted — historical CF identifiers in git history

**Finding:** early history (`62c7888` `wrangler.toml`, plus a D1 ID row in
`docs/06-ops.md` before `675dade`) committed the live Cloudflare `account_id`
and D1 `database_id`. Reachable via `git log -S`. The tracked tree is clean
since `414ad3e` (placeholders) and `c36af4f` (`wrangler.toml` →
`wrangler.toml.example`, real file gitignored).

**Decision: explicitly accept as low-sensitivity identifiers (no purge).**
`account_id` and `database_id` alone cannot authenticate — API access still
needs a scoped token, and neither value is rotatable on its own (`account_id`
is account-fixed; rotating `database_id` means recreating the D1 database).
Purging would rewrite 70+ commits, all release tags, and every deploy
`UPSTREAM_SHA` pin for no credential protection.

**Standing rule:** no live identifiers in new commits — public tree keeps
`wrangler.toml.example` placeholders only; operator ids live in the ignored
local `wrangler.toml` / deploy repo.

