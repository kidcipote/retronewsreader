-- Every feed that has ever been on a person's list. A feed taken off the list stays here, so Manage feed can show it under
-- "Had before" and it can be put back with a tap. Nothing is removed from here except with the account.
CREATE TABLE IF NOT EXISTS user_pubs_seen (
  user_id INTEGER NOT NULL REFERENCES users(id),
  pub_id  TEXT NOT NULL,
  PRIMARY KEY (user_id, pub_id)
);
INSERT OR IGNORE INTO user_pubs_seen (user_id, pub_id) SELECT user_id, pub_id FROM user_pubs;
