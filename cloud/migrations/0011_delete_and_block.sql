-- Deleting your own message: the row stays as an empty marker (so anything said under it keeps its place) and its text and story are erased.
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
-- Blocking: the blocked person cannot send a friend request to the blocker. Blocking also ends the friendship. The blocked person is not told.
CREATE TABLE IF NOT EXISTS blocks (
  blocker    INTEGER NOT NULL REFERENCES users(id),
  blocked    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker, blocked)
);
