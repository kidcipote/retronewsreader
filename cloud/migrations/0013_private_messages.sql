-- Messages private to the two people in a conversation. Each account has a key pair made in its own browser.
-- user_keys.pub is the public half, in the open. enc_priv is the private half, locked with a key derived from the account's password
-- (and so useless to anyone holding only the database); it is set to NULL when a forgotten password is reset, which is why messages
-- from before a reset can no longer be read by that person. Old rows are kept for their public half: it is what lets the other person
-- in a conversation go on reading it.
CREATE TABLE IF NOT EXISTS user_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  pub        TEXT NOT NULL,
  enc_priv   TEXT,
  enc_salt   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE users ADD COLUMN key_id INTEGER;
-- enc = 1: body holds the sealed message (text and any story together) and story is NULL. k_from and k_to are the two keys it was sealed with.
ALTER TABLE messages ADD COLUMN enc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN k_from INTEGER;
ALTER TABLE messages ADD COLUMN k_to INTEGER;
