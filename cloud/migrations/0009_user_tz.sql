-- The time zone a person's browser reports (an IANA name such as America/New_York), sent with each poll.
-- It lets a friend they are talking to see what time it is for them. Shown to accepted friends only.
ALTER TABLE users ADD COLUMN tz TEXT;
