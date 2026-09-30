# 12 — Providers

| Method | Role |
|--------|------|
| `cf_forward` | Inbound default — CF Email Routing forward + optional X-CFEG headers |
| `provider_send` / SMTP | Compose, send-proxy, reply hop via SMTP DATA |

Outbound **requires** a named `providers:` map in routing YAML. There is no free-standing global `SMTP_HOST` / `SMTP_USERNAME` / `SMTP_PASSWORD` product path — those keys exist only on the *resolved overlay* built per provider at send time.

## Named providers

```yaml
providers:
  # Keys are operator-chosen IDs (not brands, not the transport kind).
  primary_smtp_server:
    kind: smtp   # transport kind only; unknown kinds fail closed at load
    config:
      host: mail.example.com
      port: 465
      username: ${SMTP_PRIMARY_USERNAME}
      password: ${SMTP_PRIMARY_PASSWORD}
defaults:
  provider: primary_smtp_server
domains:
  example.com:
    send_as: { enabled: true }
    # provider: primary_smtp_server   # optional; falls back to defaults.provider
  other.example.com:
    send_as: { enabled: true }
    provider: primary_smtp_server   # or another named entry if you add more
```

Selection for every outbound send (compose, send-proxy, reply hop) is read off the final MIME From apex: `domains.<apex>.provider` → `defaults.provider` (required when the map is present). Unknown names fail closed at load (`routing_ok:false`); there is no silent fallback to another provider. Missing `providers:` → outbound fails closed before connect. The resolved provider **name** (never secrets) is recorded per send — `delivery_targets.provider`, attempt rows, and the compose/selftest JSON `provider` field.

`defaults.provider` is an operator-chosen key in `providers:` — not the transport `kind`. Do not use the bare word `smtp` as a provider id; it reads as the kind.

### `${SECRET_NAME}` references

Any string in a provider `config` may be a literal or a **whole-value** `${SECRET_NAME}` reference resolved from Worker secrets (e.g. wrangler secrets) at send time:

- Whole-value only — `smtp.${DOMAIN}` does not expand and stays literal (it will fail validation where a hostname is expected).
- `NAME` must match `[A-Za-z_][A-Za-z0-9_]*`. Empty, malformed, or unclosed `${...}` in whole-value position is a load-time config error — a typo'd reference never silently becomes a literal password.
- `$${NAME}` escapes to the literal string `${NAME}`.
- A ref pointing at a missing/empty/whitespace-only secret fails that provider closed **before connect** — never an empty credential on the wire.
- Refs resolve before per-provider validation, so env-sourced values face the same rules (port map, `tls` enum).
- Logs, `/health`, and diagnostics report presence booleans only — never credential values or resolved secrets.

YAML quoting: block-style `password: ${NAME}` is a plain scalar and parses as-is, but inside `{ }` **flow** mappings the braces confuse the parser — quote there (`tls: '${TLS_MODE}'`).

Guidance: `${SECRET_NAME}` is the default for any routing YAML stored in version control. Literals fit only when the YAML itself is injected as the `ROUTING_YAML` secret and never committed.

```bash
# Example secrets matching the refs above (names are yours to choose)
printf '%s' 'smtp-user' | npx wrangler secret put SMTP_PRIMARY_USERNAME
printf '%s' 'smtp-pass' | npx wrangler secret put SMTP_PRIMARY_PASSWORD
npx wrangler deploy
```

TLS is fail-closed: 465/8465/443 → implicit TLS, 587/2525/8025 → STARTTLS. Any other port returns an error instead of connecting in plaintext unless `tls:` (overlay `SMTP_TLS`) is set explicitly.

When set, `tls:` takes precedence over the port default (e.g. `587` + `tls: on` forces implicit TLS on a submission port — only set it deliberately).

Breaking change: ports 25 and 80 hard-error instead of connecting in plaintext. An internal plaintext-only relay on port 25 will break — move to a TLS-capable port (465/8465/443/587/2525/8025) instead.

## Outbound wire

All outbound (compose, send-proxy, reply hop) uses **SMTP DATA** over TCP:

```text
Worker → provider host:port (TLS)
  AUTH LOGIN
  MAIL FROM / RCPT TO
  DATA
  <exact MIME>
  .
```

Hop/proxy body is 1:1 MIME via SMTP DATA.

## Why not HTTP “send email” APIs?

Vendor HTTP MIME endpoints often **re-wrap** messages (drop HTML, new boundaries).
SMTP DATA keeps multipart/QP bodies **1:1**.
