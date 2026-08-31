-- Phase 1 schema: inbound + delivery rollup + attempts
-- reply_* tables land in Phase 2b

CREATE TABLE inbound_messages (
  id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  envelope_from TEXT,
  envelope_to TEXT,
  recipient_domain TEXT,
  subject TEXT,
  message_id TEXT,
  raw_sha256 TEXT NOT NULL,
  archive_enabled INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  raw_size INTEGER,
  archived_at INTEGER,
  rule_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_deliveries',
  last_error TEXT
);

CREATE INDEX idx_inbound_received ON inbound_messages (received_at);
CREATE INDEX idx_inbound_status ON inbound_messages (status);

CREATE TABLE delivery_targets (
  id TEXT PRIMARY KEY NOT NULL,
  inbound_id TEXT NOT NULL REFERENCES inbound_messages(id),
  destination TEXT NOT NULL,
  method TEXT NOT NULL,
  provider TEXT,
  send_as TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_provider_message_id TEXT,
  last_attempt_at INTEGER,
  succeeded_at INTEGER,
  UNIQUE (inbound_id, destination)
);

CREATE INDEX idx_targets_inbound_state ON delivery_targets (inbound_id, state);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  inbound_id TEXT NOT NULL,
  delivery_target_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  success INTEGER NOT NULL,
  error TEXT,
  method TEXT,
  provider TEXT,
  send_as TEXT,
  provider_message_id TEXT,
  provider_status TEXT,
  invocation_id TEXT,
  UNIQUE (delivery_target_id, attempt_number)
);

CREATE INDEX idx_attempts_inbound ON delivery_attempts (inbound_id, started_at);
CREATE INDEX idx_attempts_fail ON delivery_attempts (success, started_at);
