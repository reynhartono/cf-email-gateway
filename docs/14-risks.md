# 14 — Risks & known issues

## Future improvement — dedupe collision (KI)

**Current:** Message-ID present → dedupe = `sha256(from+to+normalized mid)` (ignores raw).  
**Risk:** Two *different* mails with the same from/to/Message-ID merge into one inbound (retry semantics).  
**Accept for now** (retry idempotency > rare mid reuse).  
**Later:** optional window, secondary raw check, or freeze-first-hash hybrid — see batch4 live notes.

