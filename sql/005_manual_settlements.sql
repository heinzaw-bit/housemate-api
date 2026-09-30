-- Apply after 004_hybrid_bills.sql with a privileged migration connection.
BEGIN;

CREATE TABLE housemate.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  sender_member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  recipient_member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 999999999999),
  currency text NOT NULL CHECK (currency IN ('USD', 'THB')),
  settled_on date NOT NULL,
  method text CHECK (method IS NULL OR length(trim(method)) BETWEEN 1 AND 80),
  note text CHECK (note IS NULL OR length(note) <= 500),
  recorded_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_member_id <> recipient_member_id),
  UNIQUE (household_id, recorded_by_user_id, idempotency_key)
);

CREATE INDEX settlements_household_date_idx
  ON housemate.settlements (household_id, settled_on DESC, created_at DESC, id DESC);
ALTER TABLE housemate.settlements ENABLE ROW LEVEL SECURITY;

COMMIT;
