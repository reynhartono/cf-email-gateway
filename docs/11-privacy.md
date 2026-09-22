# 11 — Privacy

- Archive = full PII; R2 private.  
- D1 attempts/participants = PII-adjacent.  
- Never commit real addresses or owner domains in examples.  
- Logs: dest + errors, not bodies.  
- No private Gmail on external-facing MIME From.  
- No X-Original-From / X-Original-Message-ID on outbound to third parties.
- Multi-person apex: person rules must `skip_default_inbox`; archive remains **operator-shared** (not tenant-isolated). See [19-multi-person-routing.md](./19-multi-person-routing.md).

## Retention / cleanup

**Out of scope for now.** R2 / D1 / reply tokens accumulate until manual delete.
