-- Apply after 010_shopping_currency.sql with a privileged migration connection.
-- Chores stay in the private housemate schema and are accessed only through the API.
BEGIN;

CREATE TABLE housemate.chores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  note text CHECK (length(note) <= 500),
  due_at timestamptz NOT NULL,
  timezone text NOT NULL,
  assignee_member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'skipped')),
  skip_reason text CHECK (length(trim(skip_reason)) BETWEEN 1 AND 500),
  closed_at timestamptz,
  closed_by_member_id uuid REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'open' AND closed_at IS NULL AND closed_by_member_id IS NULL)
      OR (status <> 'open' AND closed_at IS NOT NULL AND closed_by_member_id IS NOT NULL)),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
);

CREATE INDEX chores_household_due_idx
  ON housemate.chores (household_id, status, due_at, id);
CREATE INDEX chores_assignee_due_idx
  ON housemate.chores (assignee_member_id, due_at) WHERE status = 'open';

CREATE TABLE housemate.chore_swap_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chore_id uuid NOT NULL REFERENCES housemate.chores(id) ON DELETE RESTRICT,
  requested_by_member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  target_member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (requested_by_member_id <> target_member_id),
  CHECK ((status = 'pending') = (responded_at IS NULL))
);
CREATE UNIQUE INDEX chore_one_pending_swap_idx
  ON housemate.chore_swap_requests (chore_id) WHERE status = 'pending';

ALTER TABLE housemate.chores ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.chore_swap_requests ENABLE ROW LEVEL SECURITY;

COMMIT;
