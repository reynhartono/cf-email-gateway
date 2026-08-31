# Phase 2a — Compose / SMTP (synthetic)

**Base URL:** `https://cf-email-gateway.<account>.workers.dev`  
**Auth:** `Authorization: Bearer $COMPOSE_API_TOKEN`

| Id | Case | Expect |
|----|------|--------|
| C1 | POST /v1/compose From me@example.com To me@gmail.com | 200, mail From @example.com |
| C2 | display name | Gmail shows display; domain example.com |
| C3 | unauthorized domain From | 400 send_as not enabled |
| C4 | multi To | both receive |
| C5 | smtp-selftest | transport smtp, multipart OK |

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  https://cf-email-gateway.<account>.workers.dev/v1/compose \
  -d '{"from":"me@example.com","to":"me@gmail.com","subject":"hi","text":"hello"}'
```

Requires `domains.example.com.send_as.enabled: true` and SMTP domain verified at your ESP.
