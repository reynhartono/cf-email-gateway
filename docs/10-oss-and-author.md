# 10 — Config hygiene (git vs live)

## In git

- Example only: `config/routing.example.yaml`  
- Synthetic fixtures: `me@gmail.com`, `me@example.com`, `example.com`  
- No personal emails, owner domains, real `.eml`, or API tokens  
- License **MIT**

## Live only (not committed)

| Piece | Where |
|-------|--------|
| Routing | wrangler secret `ROUTING_YAML` and/or gitignored `config/routing.local.yaml` |
| SMTP / compose | wrangler secrets (`SMTP_*`, `COMPOSE_API_TOKEN`) |
| CF account / D1 ids | local `wrangler.toml` (from example); do not commit real values |
| Catch-all → Worker | Email Routing dashboard or your infra IaC |
| Agent host secrets | machine-local config (e.g. `~/.config/…`) |

Dashboard plain-text Worker vars are wiped by `wrangler deploy` — prefer **secrets**.
