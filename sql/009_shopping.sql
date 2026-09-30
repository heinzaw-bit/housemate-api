-- Apply after 008_meals.sql with a privileged migration connection.
-- Shopping records remain in the private housemate schema and are accessed only through the API.
BEGIN;

CREATE TABLE housemate.shopping_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  quantity numeric(12,3) CHECK (quantity > 0 AND quantity <= 999999999),
  unit text CHECK (length(trim(unit)) BETWEEN 1 AND 40),
  note text CHECK (length(note) <= 500),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  assigned_buyer_member_id uuid REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'assigned', 'purchased', 'cancelled')),
  estimated_price_minor bigint CHECK (estimated_price_minor BETWEEN 0 AND 999999999999),
  purchased_price_minor bigint CHECK (purchased_price_minor BETWEEN 0 AND 999999999999),
  purchased_by_member_id uuid REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  purchased_at timestamptz,
  cancelled_at timestamptz,
  linked_expense_id uuid UNIQUE REFERENCES housemate.expenses(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'needed' OR assigned_buyer_member_id IS NULL),
  CHECK (status <> 'assigned' OR assigned_buyer_member_id IS NOT NULL),
  CHECK ((status = 'purchased') = (purchased_at IS NOT NULL AND purchased_by_member_id IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status = 'purchased' OR (purchased_price_minor IS NULL AND linked_expense_id IS NULL))
);

CREATE INDEX shopping_items_household_status_idx
  ON housemate.shopping_items (household_id, status, updated_at DESC, id DESC);
CREATE INDEX shopping_items_assigned_idx
  ON housemate.shopping_items (assigned_buyer_member_id, status)
  WHERE assigned_buyer_member_id IS NOT NULL;

ALTER TABLE housemate.shopping_items ENABLE ROW LEVEL SECURITY;

COMMIT;
