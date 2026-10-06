-- The Filter menu's choices (topics, places, and the sources switched off) follow the account, like saved and read stories.
-- Sources are kept as the ones switched off, so an outlet added later starts switched on.
CREATE TABLE IF NOT EXISTS user_filters (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id),
  filters    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
