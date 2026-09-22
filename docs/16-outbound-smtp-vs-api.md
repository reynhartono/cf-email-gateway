# 16 — Outbound SMTP

Moved into [12-providers.md](./12-providers.md), which is now the single SoT for SMTP secrets, TLS fail-closed, and the DATA path.

This file stays as a pointer so numbered links (`docs/16`, skill refs, old PRs) don't break. Do not add new SMTP content here — edit `docs/12-providers.md` instead.

Wire diagram and HTTP-API rationale live in `docs/12-providers.md` → `Outbound wire`.

Original wire (kept for link context):

```text
Worker → SMTP_HOST:SMTP_PORT (TLS)
  AUTH LOGIN
  MAIL FROM / RCPT TO
  DATA
  <exact MIME>
  .
```

Vendor HTTP MIME endpoints often **re-wrap** messages (drop HTML, new boundaries).
SMTP DATA keeps multipart/QP bodies **1:1**.
