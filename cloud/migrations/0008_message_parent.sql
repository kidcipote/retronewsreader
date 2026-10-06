-- Comments on a shared story, and replies to a comment. A comment is a message whose parent_id is the story message;
-- a reply is a message whose parent_id is a comment. Nothing goes deeper (the API refuses a reply to a reply).
-- No REFERENCES clause on purpose: deleting an account deletes the messages it sent, and what answered them is re-pointed first (social.js).
ALTER TABLE messages ADD COLUMN parent_id INTEGER;
CREATE INDEX IF NOT EXISTS messages_parent ON messages(parent_id);
