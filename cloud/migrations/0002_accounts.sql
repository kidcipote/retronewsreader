-- Beta hardening: email as the recovery identity, reset and verification tokens, recovery codes, account deletion.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN deleted_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
-- how the session was started: password, recovery (a recovery code), reset
ALTER TABLE sessions ADD COLUMN via TEXT NOT NULL DEFAULT 'password';
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- single-use links sent by email. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,              -- verify | reset
  email      TEXT NOT NULL,              -- the address the link was sent to
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, kind);
-- ten per account, shown once, hashed at rest, each good for one sign-in
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id   INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at   TEXT,
  PRIMARY KEY (user_id, code_hash)
);
