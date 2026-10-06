-- Whose invite link an account was made through. Links are permanent and shared freely (since 2026-10-05), so the invites table no longer
-- says who joined through which: the account itself now does. It is what the operator's "Top inviters" report counts.
ALTER TABLE users ADD COLUMN invited_by INTEGER REFERENCES users(id);
-- accounts from the single-use days: the code they used names its maker
UPDATE users SET invited_by = (SELECT i.created_by FROM invites i WHERE i.used_by = users.id LIMIT 1) WHERE invited_by IS NULL;
-- accounts made through a permanent link before this column existed: the friendship that sign-up made at the same moment names the inviter
UPDATE users SET invited_by = (SELECT b.requested_by FROM buddies b WHERE (b.a = users.id OR b.b = users.id) AND b.requested_by != users.id AND b.status = 'accepted'
  AND abs(strftime('%s', b.created_at) - strftime('%s', users.created_at)) <= 5 LIMIT 1) WHERE invited_by IS NULL AND deleted_at IS NULL;
