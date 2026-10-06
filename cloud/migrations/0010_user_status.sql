-- A status a person sets for their friends to see, like an away message: one emoji and a short line of text.
-- Both empty means no status, and friends see Active or Away from whether the reader is open. Shown to accepted friends only.
ALTER TABLE users ADD COLUMN status_emoji TEXT;
ALTER TABLE users ADD COLUMN status_text TEXT;
