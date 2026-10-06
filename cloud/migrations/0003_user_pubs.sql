-- Each person's own list of publications. The registry of everything fetched stays in KV (config.publications);
-- this table says which of those a person sees. Signed off, the page shows a fixed three-outlet front page.
CREATE TABLE IF NOT EXISTS user_pubs (
  user_id  INTEGER NOT NULL REFERENCES users(id),
  pub_id   TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, pub_id)
);
