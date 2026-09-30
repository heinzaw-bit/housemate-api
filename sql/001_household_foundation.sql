-- Apply once to a Supabase PostgreSQL database using a privileged migration connection.
-- The application uses the private housemate schema; no client role receives access.
BEGIN;

CREATE SCHEMA IF NOT EXISTS housemate;
REVOKE ALL ON SCHEMA housemate FROM PUBLIC;

CREATE TABLE housemate.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE housemate.households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  default_currency text NOT NULL CHECK (default_currency IN ('USD', 'THB')),
  timezone text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE housemate.household_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL CHECK (status IN ('invited', 'active', 'left', 'removed')),
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, user_id)
);

CREATE INDEX household_members_user_status_idx
  ON housemate.household_members (user_id, status);

-- Private schema is inaccessible through Supabase's exposed Data API roles.
-- RLS is enabled as a second barrier if access is granted accidentally later.
ALTER TABLE housemate.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.households ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.household_members ENABLE ROW LEVEL SECURITY;

COMMIT;
