-- Phase 2b: reply routes + participants

CREATE TABLE IF NOT EXISTS reply_routes (
  token TEXT PRIMARY KEY NOT NULL,
  inbound_id TEXT NOT NULL,
  our_domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  multiparty INTEGER NOT NULL DEFAULT 1,
  subject TEXT,
  FOREIGN KEY (inbound_id) REFERENCES inbound_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_reply_routes_inbound ON reply_routes(inbound_id);

CREATE TABLE IF NOT EXISTS reply_participants (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL,
  email TEXT NOT NULL,
  display_hint TEXT,
  role TEXT NOT NULL,           -- primary | cc | other
  local_suffix TEXT,            -- null for primary, p1, p2, ... or 'all' synthetic
  in_primary INTEGER NOT NULL DEFAULT 0,
  in_all INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (token) REFERENCES reply_routes(token)
);

CREATE INDEX IF NOT EXISTS idx_reply_participants_token ON reply_participants(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_participants_token_email ON reply_participants(token, email);
