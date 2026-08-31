# 05 — Ingestion

```text
raw buffer → dedupe → archive? → destinations → deliver → SUCCESS gate
```

1. Parse envelope + headers.  
2. Dedupe: Message-ID present → mid key only; else + raw_sha256.  
3. `resolveDestinations` + `resolve_driver` → almost always `cf_forward`.  
4. Archive (if on) same run even if R2 fails.  
5. Mint forward token; attach X-CFEG on each cf_forward.  
6. Deliver pending targets; log attempts.  
7. SUCCESS iff archive_ok (if required) ∧ all dests succeeded; else THROW retryable.

| Path | Driver |
|------|--------|
| Normal inbound | cf_forward |
| Reply hop / send-proxy | provider_send (SMTP) |
