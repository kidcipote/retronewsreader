-- Data minimisation, step 2 of 2 (2026-10-05). Applied after the Worker that no longer reads these was live.
-- Which account came through which link is gone (0017 turned it into counts). The tagged-link name on the account likewise.
UPDATE users SET invited_by = NULL, invite_source = NULL;
-- invites.used_by was the single-use codes' record of who used one; nothing has written it since links became permanent.
UPDATE invites SET used_by = NULL;
-- A message keeps whether it was read (any non-empty value), not when.
UPDATE messages SET read_at = '1' WHERE read_at IS NOT NULL;
-- The read list keeps the order stories were marked (rowid) and no time.
ALTER TABLE user_read DROP COLUMN read_at;
-- Recovery codes were removed on 2026-10-05; the empty table goes.
DROP TABLE IF EXISTS recovery_codes;
