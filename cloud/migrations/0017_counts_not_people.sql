-- Data minimisation, step 1 of 2 (2026-10-05). Who joined through whose link becomes a count, not a record on each account.
-- users.joined_count: how many accounts were made through this person's links (their ordinary link and any tagged one of theirs).
-- invites.joined: the same for a tagged link, so Tagged links and the sources in Top inviters keep working.
-- Additive, so the Worker running now is not disturbed; 0018 removes what these replace once the new Worker is live.
ALTER TABLE users ADD COLUMN joined_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN joined INTEGER NOT NULL DEFAULT 0;
UPDATE users SET joined_count = (SELECT COUNT(*) FROM users j WHERE j.invited_by = users.id AND j.deleted_at IS NULL);
UPDATE invites SET joined = (SELECT COUNT(*) FROM users j WHERE j.deleted_at IS NULL AND j.invite_source = invites.source) WHERE source IS NOT NULL;
