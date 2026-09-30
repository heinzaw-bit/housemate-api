-- Apply once after 002_member_onboarding.sql with a privileged migration connection.
BEGIN;

CREATE TABLE housemate.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 999999999999),
  currency text NOT NULL CHECK (currency IN ('USD', 'THB')),
  spent_on date NOT NULL,
  payer_member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  split_method text NOT NULL CHECK (split_method IN ('equal', 'exact', 'percentage', 'ratio')),
  split_input jsonb NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, created_by_user_id, idempotency_key)
);

CREATE TABLE housemate.expense_shares (
  expense_id uuid NOT NULL REFERENCES housemate.expenses(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (expense_id, member_id)
);

CREATE INDEX expenses_household_date_idx ON housemate.expenses (household_id, spent_on DESC, created_at DESC, id DESC);
ALTER TABLE housemate.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.expense_shares ENABLE ROW LEVEL SECURITY;

COMMIT;
