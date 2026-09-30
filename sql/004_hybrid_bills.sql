-- Apply after 003_shared_expenses.sql with a privileged migration connection.
BEGIN;

CREATE TABLE housemate.bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  bill_type text NOT NULL CHECK (bill_type IN ('electricity', 'water', 'internet', 'rent', 'other')),
  provider text NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 160),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 999999999999),
  currency text NOT NULL CHECK (currency IN ('USD', 'THB')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  due_date date NOT NULL,
  payer_member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  payment_status text NOT NULL CHECK (payment_status IN ('unpaid', 'paid')),
  shared_participant_ids jsonb NOT NULL,
  adjustments jsonb NOT NULL,
  base_minor bigint NOT NULL CHECK (base_minor BETWEEN 0 AND 999999999999),
  charge_minor bigint NOT NULL CHECK (charge_minor >= 0),
  credit_minor bigint NOT NULL CHECK (credit_minor >= 0),
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  status_updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start <= period_end),
  UNIQUE (household_id, created_by_user_id, idempotency_key)
);

CREATE TABLE housemate.bill_shares (
  bill_id uuid NOT NULL REFERENCES housemate.bills(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  base_minor bigint NOT NULL CHECK (base_minor >= 0),
  adjustment_minor bigint NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (bill_id, member_id),
  CHECK (base_minor + adjustment_minor = amount_minor)
);

CREATE TABLE housemate.bill_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES housemate.bills(id) ON DELETE RESTRICT,
  old_status text CHECK (old_status IN ('unpaid', 'paid')),
  new_status text NOT NULL CHECK (new_status IN ('unpaid', 'paid')),
  changed_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bills_household_due_idx ON housemate.bills (household_id, due_date DESC, created_at DESC, id DESC);
CREATE INDEX bill_status_events_bill_idx ON housemate.bill_status_events (bill_id, changed_at DESC);
ALTER TABLE housemate.bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.bill_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.bill_status_events ENABLE ROW LEVEL SECURITY;

COMMIT;
