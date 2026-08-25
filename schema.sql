CREATE TABLE IF NOT EXISTS personas (
  handle          TEXT PRIMARY KEY,
  fomo_id         TEXT,
  name            TEXT,
  solana_address  TEXT,
  evm_address     TEXT,
  chat_id         TEXT NOT NULL,
  last_signature  TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_theses (
  id       TEXT PRIMARY KEY,
  handle   TEXT NOT NULL,
  seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  telegram_offset   INTEGER NOT NULL DEFAULT 0,
  webhook_cleared   INTEGER NOT NULL DEFAULT 0,
  helius_webhook_id TEXT,
  last_test_at      TEXT
);

INSERT OR IGNORE INTO poll_state (id) VALUES (1);
