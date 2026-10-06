-- A reader can report a feed (and, later, a buddy). Reports are a safety valve read by the operator, not a ranking.
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,              -- feed
  target     TEXT NOT NULL,              -- the publication id
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
