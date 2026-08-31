# 07 — Repo structure

```text
├── AGENTS.md
├── README.md
├── config/
│   ├── routing.example.yaml   # committed synthetic example
│   └── routing.local.yaml     # gitignored operator PII
├── docs/
├── migrations/
├── scripts/                   # optional scenario helpers
├── src/
│   ├── index.js               # email + fetch entry
│   ├── config.js
│   ├── pipeline.js            # inbound core
│   ├── compose.js             # HTTP compose / smtp-selftest
│   ├── forward_headers.js     # X-CFEG v2
│   ├── reply_tokens.js
│   ├── send_proxy.js
│   ├── mime_rebuild.js
│   └── providers/
│       ├── cf_forward.js
│       ├── smtp.js
│       └── send_outbound.js
└── test/
    ├── *.test.js
    └── scenarios/*.yaml       # synthetic fixtures
```
