-- Apply after 005_manual_settlements.sql with a privileged migration connection.
BEGIN;

ALTER TABLE housemate.expenses
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE housemate.bills
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE housemate.financial_edit_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  resource_type text NOT NULL CHECK (resource_type IN ('expense', 'bill')),
  resource_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL CHECK (expected_revision > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);
CREATE INDEX financial_edit_previews_expiry_idx
  ON housemate.financial_edit_previews (expires_at);

CREATE TABLE housemate.financial_edit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  resource_type text NOT NULL CHECK (resource_type IN ('expense', 'bill')),
  resource_id uuid NOT NULL,
  changed_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  before_revision integer NOT NULL CHECK (before_revision > 0),
  after_revision integer NOT NULL CHECK (after_revision = before_revision + 1),
  before_record jsonb NOT NULL,
  after_record jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, changed_by_user_id, idempotency_key)
);
CREATE INDEX financial_edit_events_resource_idx
  ON housemate.financial_edit_events (household_id, resource_type, resource_id, changed_at DESC);

ALTER TABLE housemate.financial_edit_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.financial_edit_events ENABLE ROW LEVEL SECURITY;
COMMIT;
