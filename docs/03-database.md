# 03 — Storage (R2 + D1)

## R2

Only if archive used. Keys e.g. `raw/dt=YYYY-MM-DD/domain=<d>/id=<uuid>.eml`.

## D1

### `inbound_messages`

| Column | Notes |
|--------|--------|
| `id` | PK UUID (surrogate) |
| `dedupe_key` | UNIQUE (logical identity) |
| envelopes, subject, message_id, raw_sha256 | |
| `archive_enabled`, `r2_key`, `archived_at` | |
| `rule_id`, `status` | e.g. `pending_deliveries` \| `completed` \| `ingested_only` |
| `last_error` | summary |

### `delivery_targets`

| Column | Notes |
|--------|--------|
| `inbound_id`, `destination` | UNIQUE pair |
| `method` | `cf_forward` \| `provider_send` (SMTP hop/proxy) |
| `provider`, `send_as` | snapshots |
| `state` | pending \| succeeded \| failed |
| attempt_count, last_*, succeeded_at | |

### `delivery_attempts` (append-only)

One row when attempt **finishes**. Unique `(delivery_target_id, attempt_number)`.

### `reply_routes` / `reply_participants` (Phase 2b)

Token PK; `inbound_id` indexed (Q43: **one product token per inbound** — reuse on dedupe, do not mint another). Participants with `in_primary` / `in_all` / `local_suffix` (pN).

### Optional

`routing_config` snapshot table — not required if config is bundled from git.

## Why both `id` and `dedupe_key`?

- `dedupe_key` = find same logical mail on sender retry  
- `id` = short FK / R2 path / logs  
