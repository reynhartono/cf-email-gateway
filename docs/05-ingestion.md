# 05 — Ingestion

```text
raw buffer → detect shapes → destinations → insert → archive?
  → (exception: authorized hop/proxy) OR default cf_forward → SUCCESS gate
```

1. Parse envelope + headers; **detect** r+ / send-proxy shapes (do not branch yet).  
2. Dedupe: Message-ID present → mid key only; else + raw_sha256.  
3. `resolveDestinations` + `resolve_driver` → almost always `cf_forward`.  
4. **Insert inbound always**; archive (if on) same run even if R2 fails.  
5. **Default = forward.** Exception only if pattern ∧ authorized ∧ identity-bound → hop/proxy SMTP.  
6. Else mint forward token; attach X-CFEG on each cf_forward; deliver pending targets.  
7. SUCCESS iff archive_ok (if required) ∧ all dests succeeded; else THROW retryable.

| Path | When | Driver |
|------|------|--------|
| **Default inbound** | always unless exception fires | `cf_forward` |
| Reply hop | `r+TOKEN@` + authorized | `provider_send` (SMTP) |
| Send-proxy | proxy shape + authorized | `provider_send` (SMTP) |
| Unauthorized proxy/r+ shape | pattern matched, auth failed | **default** `cf_forward` |
