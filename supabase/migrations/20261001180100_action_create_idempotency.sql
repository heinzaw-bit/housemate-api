-- Additive: legacy callers may omit the key; current private-table RLS/grants stay intact.
SET LOCAL lock_timeout = '5s';
ALTER TABLE housemate.shopping_items ADD COLUMN idempotency_key uuid, ADD COLUMN request_hash text;
ALTER TABLE housemate.chores ADD COLUMN idempotency_key uuid, ADD COLUMN request_hash text;
ALTER TABLE housemate.shopping_items ADD CONSTRAINT shopping_create_key_hash CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));
ALTER TABLE housemate.chores ADD CONSTRAINT chore_create_key_hash CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));
CREATE UNIQUE INDEX shopping_create_request_idx ON housemate.shopping_items (household_id, created_by_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX chore_create_request_idx ON housemate.chores (household_id, created_by_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
