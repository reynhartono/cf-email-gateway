# cf-email-gateway

Cloudflare **Email Routing** Worker that:

1. Optionally **archives** inbound MIME → R2  
2. **Routes** by YAML config (rules / `default_inbox` / ingest-only)  
3. **Delivers** via `cf_forward` + **X-CFEG-\* v2** reply tokens  
4. **Compose / send-proxy / reply hop** via generic **SMTP** (DATA for 1:1 bodies)  
5. Logs **delivery_attempts**; retries skip succeeded destinations  
6. SUCCESS only when archive (if on) **and** required deliveries succeed  

> License **MIT**. Clean-room.  
> Companion extension: [cfeg-reply-extension](https://github.com/reynhartono/cfeg-reply-extension) (separate repo)

## Installation

**Full guide:** [docs/18-installation.md](docs/18-installation.md)

### Dev

```bash
git clone https://github.com/reynhartono/cf-email-gateway.git
cd cf-email-gateway
npm install
npm test
```

### Production (summary)

1. `npx wrangler login` (or `CLOUDFLARE_API_TOKEN`)  
2. Create D1 + R2; `cp wrangler.toml.example wrangler.toml` and set ids (`DB` / `ARCHIVE` bindings)   
3. `npx wrangler d1 migrations apply cf-email-gateway --remote`  
4. Copy [`config/routing.example.yaml`](config/routing.example.yaml) → edit →  
   `npx wrangler secret put ROUTING_YAML < config/routing.local.yaml`  
5. Secrets: `SMTP_HOST`, `SMTP_USERNAME`, `SMTP_PASSWORD`, optional `SMTP_PORT`, `COMPOSE_API_TOKEN`  
6. `npx wrangler deploy`  
7. Email Routing catch-all → Worker **`cf-email-gateway`** (destination must match `default_inbox`)  
8. Smoke: `GET /health`, `GET /v1/smtp-selftest?to=…` (Bearer token), send a test mail  

**After every secret change:** deploy again.

### Verify (quick)

```bash
curl -sS "https://cf-email-gateway.<account>.workers.dev/health"

curl -sS -H "Authorization: Bearer $COMPOSE_API_TOKEN" \
  "https://cf-email-gateway.<account>.workers.dev/v1/smtp-selftest?to=me@gmail.com"
```

## Docs

**Start here:** [docs/README.md](docs/README.md)

| Doc | Purpose |
|-----|---------|
| [docs/18-installation.md](docs/18-installation.md) | **Install / deploy** |
| [docs/09-decisions.md](docs/09-decisions.md) | Product defaults |
| [docs/15-x-cfeg-header-contract.md](docs/15-x-cfeg-header-contract.md) | **X-CFEG v2 + scenarios** |
| [docs/13-delivery-and-reply.md](docs/13-delivery-and-reply.md) | Delivery + hop |
| [docs/02-config-and-routing.md](docs/02-config-and-routing.md) | YAML routing |
| [docs/08-roadmap.md](docs/08-roadmap.md) | Phases |
| [docs/16-outbound-smtp-vs-api.md](docs/16-outbound-smtp-vs-api.md) | SMTP DATA |
| [docs/17-send-proxy.md](docs/17-send-proxy.md) | Send-proxy addressing |
