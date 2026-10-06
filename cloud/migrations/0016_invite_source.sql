-- Tagged invite links: a second link for the same person that says where it was posted (the first is "instagram", for a caption).
-- The tag is on the link (invites.source; NULL for a person's ordinary link) and is copied to the account made through it
-- (users.invite_source), so the operator can tell which accounts came from where.
ALTER TABLE invites ADD COLUMN source TEXT;
ALTER TABLE users ADD COLUMN invite_source TEXT;
