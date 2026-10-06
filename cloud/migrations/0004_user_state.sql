-- Saved and read stories follow the account, so they are the same on every browser and device a person signs on from.
-- A saved story keeps a full snapshot, so it stays readable after the archive prunes it.
CREATE TABLE IF NOT EXISTS user_saved (
  user_id  INTEGER NOT NULL REFERENCES users(id),
  item_id  TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS user_read (
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);
