-- The operator's analysis store (2026-10-06). Stories the operator picks in the Saved view and syncs are kept here whole, one row each, so they
-- can be queried, exported or handed to an AI later. Only the operator account can write or read it (File -> Download synced stories, or the
-- database itself). It is the operator's own selection of published articles; nothing about any other reader is kept in it.
CREATE TABLE IF NOT EXISTS story_records (
  id           TEXT PRIMARY KEY,      -- the story's id in the reader
  pub          TEXT,                  -- the feed it came from
  outlet       TEXT,
  section      TEXT,
  title        TEXT,
  link         TEXT,
  author       TEXT,
  published_at TEXT,
  first_seen   TEXT,
  saved_at     TEXT,
  language     TEXT,
  summary      TEXT,
  content      TEXT,                  -- the full text as the feed gave it (HTML, cleaned)
  image        TEXT,
  categories   TEXT,                  -- JSON: the publisher's own categories
  topics       TEXT,                  -- JSON: [{name, p}] as tagged
  places       TEXT,                  -- JSON: [{name, p}]
  extra        TEXT,                  -- JSON: any other field the story carried
  user_id      INTEGER,               -- the operator who synced it
  synced_at    TEXT NOT NULL DEFAULT (datetime('now')),   -- first synced
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))    -- last synced
);
CREATE INDEX IF NOT EXISTS idx_story_records_published ON story_records (published_at);
