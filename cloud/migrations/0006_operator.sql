-- The operator is an account, not a browser holding a token. One row is marked by hand; sign on as that account and the operator's
-- controls are there. The admin token remains for machines (the deploy script, maintenance calls).
ALTER TABLE users ADD COLUMN is_operator INTEGER NOT NULL DEFAULT 0;
