-- Safe to re-run on an existing DB created from the original schema.
-- SQLite has no ADD COLUMN IF NOT EXISTS; ignore "duplicate column" if it errors.

ALTER TABLE personas ADD COLUMN last_signature TEXT;

CREATE TABLE IF NOT EXISTS poll_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  telegram_offset   INTEGER NOT NULL DEFAULT 0,
  webhook_cleared   INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO poll_state (id) VALUES (1);

ALTER TABLE poll_state ADD COLUMN helius_webhook_id TEXT;
ALTER TABLE poll_state ADD COLUMN last_webhook_at TEXT;
ALTER TABLE poll_state ADD COLUMN last_webhook_note TEXT;
ALTER TABLE poll_state ADD COLUMN last_test_at TEXT;

CREATE TABLE IF NOT EXISTS seen_theses (
  id       TEXT PRIMARY KEY,
  handle   TEXT NOT NULL,
  seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evm_cursors (
  wallet  TEXT NOT NULL,
  chain   TEXT NOT NULL,
  last_tx TEXT,
  PRIMARY KEY (wallet, chain)
);
