# 12 — Providers

| Method | Role |
|--------|------|
| `cf_forward` | Inbound default — CF Email Routing forward + optional X-CFEG headers |
| `provider_send` / SMTP | Compose, send-proxy, reply hop via SMTP DATA |

Secrets: `SMTP_HOST`, `SMTP_USERNAME` (or `SMTP_USER`), `SMTP_PASSWORD` (or `SMTP_PASS`), optional `SMTP_PORT` (default 465), optional `SMTP_TLS` (`on` | `starttls` for rare ports).

That global set is the **legacy path**: it applies when the routing config has
no `providers:` map. With a map, each provider carries its own connection
fields and the legacy globals are ignored for sends.

## Named providers (per-domain senders)

```yaml
providers:
  # Keys are operator-chosen IDs (not brands, not the transport kind).
  primary_submission:
    kind: smtp   # transport kind only; unknown kinds fail closed at load
    config:
      host: mail.example.com
      port: 465
      username: ${SMTP_PRIMARY_USERNAME}
      password: ${SMTP_PRIMARY_PASSWORD}
  alt_submission:
    kind: smtp
    config:
      host: smtp.other.example.com
      port: 587
      username: plain-user
      password: ${SMTP_ALT_PASSWORD}
defaults:
  provider: primary_submission
domains:
  example.com:
    send_as: { enabled: true }
    provider: primary_submission
  other.example.com:
    send_as: { enabled: true }
    provider: alt_submission
```

Selection for every outbound send (compose, send-proxy, reply hop) is read off
the final MIME From apex: `domains.<apex>.provider` → `defaults.provider`
(which is required when the map is present). Unknown names fail closed at
load (`routing_ok:false`); there is no silent fallback to another provider or
to the legacy globals. The resolved provider **name** (never secrets) is
recorded per send — `delivery_targets.provider`, attempt rows, and the
compose/selftest JSON `provider` field.

`defaults.provider` previously carried a delivery-driver label (`smtp`); it
now names a key in `providers:` (an operator-chosen ID, not `kind`). Migration:
configs without a `providers:` map keep working on the legacy path, but once
you add the map an old `provider: smtp` label is read as a selection — rename
the selection (e.g. to `primary_submission`) or name a provider key `smtp`.

### `${SECRET_NAME}` references

Any string in a provider `config` may be a literal or a **whole-value**
`${SECRET_NAME}` reference resolved from Worker secrets (e.g. wrangler
secrets) at send time:

- Whole-value only — `smtp.${DOMAIN}` does not expand and stays literal (it
  will fail validation where a hostname is expected).
- `NAME` must match `[A-Za-z_][A-Za-z0-9_]*`. Empty, malformed, or unclosed
  `${...}` in whole-value position is a load-time config error — a typo'd
  reference never silently becomes a literal password.
- `$${NAME}` escapes to the literal string `${NAME}`.
- A ref pointing at a missing/empty/whitespace-only secret fails that
  provider closed **before connect** — never an empty credential on the wire.
- Refs resolve before per-provider validation, so env-sourced values face the
  same rules (port map, `tls` enum).
- Logs, `/health`, and diagnostics report presence booleans only (e.g. the
  selftest `present` block) — never credential values or resolved secrets.

YAML quoting: block-style `password: ${NAME}` is a plain scalar and parses
as-is, but inside `{ }` **flow** mappings the braces confuse the parser —
quote there (`tls: '${TLS_MODE}'`).

Guidance: `${SECRET_NAME}` is the default for any routing YAML stored in
version control. Literals fit only when the YAML itself is injected as the
`ROUTING_YAML` secret and never committed.

```bash
printf '%s' 'mail.example.com' | npx wrangler secret put SMTP_HOST
printf '%s' 'smtp-user'        | npx wrangler secret put SMTP_USERNAME
printf '%s' 'smtp-pass'        | npx wrangler secret put SMTP_PASSWORD
# optional:
# printf '%s' '465' | npx wrangler secret put SMTP_PORT
npx wrangler deploy
```

TLS is fail-closed: 465/8465/443 → implicit TLS, 587/2525/8025 → STARTTLS. Any other port returns an error instead of connecting in plaintext unless `SMTP_TLS` is set explicitly.

When set, `SMTP_TLS` takes precedence over the port default (e.g. `587` + `SMTP_TLS=on` forces implicit TLS on a submission port — only set it deliberately).

Breaking change: ports 25 and 80 now hard-error instead of connecting in plaintext. An internal plaintext-only relay on port 25 will break on upgrade — setting `SMTP_TLS` will not help unless the server actually speaks TLS on that port; move to a TLS-capable port (465/8465/443/587/2525/8025) instead.

## Outbound wire

All outbound (compose, send-proxy, reply hop) uses **SMTP DATA** over TCP:

```text
Worker → SMTP_HOST:SMTP_PORT (TLS)
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
