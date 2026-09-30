-- Household events stay in the private housemate schema. The API enforces membership.
BEGIN;

CREATE TABLE housemate.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 160),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  timezone text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  UNIQUE (household_id, created_by_user_id, idempotency_key)
);

CREATE INDEX events_household_start_idx ON housemate.events (household_id, starts_at, id);

CREATE TABLE housemate.event_attendance (
  event_id uuid NOT NULL REFERENCES housemate.events(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  response text NOT NULL CHECK (response IN ('going', 'maybe', 'not_going')),
  responded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, member_id)
);

CREATE INDEX event_attendance_member_idx ON housemate.event_attendance (member_id, event_id);

ALTER TABLE housemate.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.event_attendance ENABLE ROW LEVEL SECURITY;

COMMIT;
