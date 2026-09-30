-- Apply after 007_financial_voids.sql with a privileged migration connection.
-- Meal records stay in the private housemate schema. The API enforces membership.
BEGIN;

CREATE TABLE housemate.meal_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  meal_type text NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'other')),
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 240),
  starts_at timestamptz NOT NULL,
  response_deadline timestamptz NOT NULL,
  timezone text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (response_deadline <= starts_at),
  UNIQUE (household_id, created_by_user_id, idempotency_key)
);

CREATE INDEX meal_checks_household_start_idx
  ON housemate.meal_checks (household_id, starts_at, id);

CREATE TABLE housemate.meal_participants (
  meal_id uuid NOT NULL REFERENCES housemate.meal_checks(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  response text CHECK (response IN ('joining', 'not_joining', 'maybe')),
  responded_at timestamptz,
  PRIMARY KEY (meal_id, member_id),
  CHECK ((response IS NULL) = (responded_at IS NULL))
);

CREATE INDEX meal_participants_member_idx ON housemate.meal_participants (member_id, meal_id);

CREATE TABLE housemate.meal_cooking_roles (
  meal_id uuid NOT NULL REFERENCES housemate.meal_checks(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (length(trim(role)) BETWEEN 1 AND 60),
  PRIMARY KEY (meal_id, member_id, role)
);

CREATE INDEX meal_cooking_roles_member_idx ON housemate.meal_cooking_roles (member_id, meal_id);

ALTER TABLE housemate.meal_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.meal_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.meal_cooking_roles ENABLE ROW LEVEL SECURITY;

COMMIT;
