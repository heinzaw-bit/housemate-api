-- Apply after 006_financial_edits.sql with a privileged migration connection.
BEGIN;

ALTER TABLE housemate.expenses
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by_user_id uuid REFERENCES housemate.users(id) ON DELETE RESTRICT,
  ADD COLUMN void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  ADD CONSTRAINT expenses_void_actor_check
    CHECK ((voided_at IS NULL) = (voided_by_user_id IS NULL));

ALTER TABLE housemate.bills
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by_user_id uuid REFERENCES housemate.users(id) ON DELETE RESTRICT,
  ADD COLUMN void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  ADD CONSTRAINT bills_void_actor_check
    CHECK ((voided_at IS NULL) = (voided_by_user_id IS NULL));

ALTER TABLE housemate.financial_edit_events
  ADD COLUMN action text NOT NULL DEFAULT 'edit'
    CHECK (action IN ('edit', 'void'));

COMMIT;
