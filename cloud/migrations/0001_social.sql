-- Accounts, buddies and instant messages for the NYC Feed Reader.
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES users(id),
  used_by    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- one row per pair, a < b
CREATE TABLE IF NOT EXISTS buddies (
  a            INTEGER NOT NULL REFERENCES users(id),
  b            INTEGER NOT NULL REFERENCES users(id),
  requested_by INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES users(id),
  to_id      INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL DEFAULT 'text',
  body       TEXT NOT NULL,
  story      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS messages_to   ON messages(to_id, read_at, id);
CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_id, to_id, id);
