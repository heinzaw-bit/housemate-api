-- Apply after 001_household_foundation.sql with a privileged migration connection.
-- Invite tokens are never stored here; only their SHA-256 hashes are stored.
BEGIN;

ALTER TABLE housemate.households
  ADD COLUMN currency_locked_at timestamptz;

COMMENT ON COLUMN housemate.households.currency_locked_at IS
  'The first confirmed financial write must set this timestamp in the same transaction. Currency cannot change afterward.';

CREATE TABLE housemate.household_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_by_user_id uuid REFERENCES housemate.users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((redeemed_at IS NULL) = (redeemed_by_user_id IS NULL))
);

CREATE INDEX household_invites_household_idx
  ON housemate.household_invites (household_id, created_at DESC);

CREATE UNIQUE INDEX household_members_one_active_owner_idx
  ON housemate.household_members (household_id)
  WHERE role = 'owner' AND status = 'active';

ALTER TABLE housemate.household_invites ENABLE ROW LEVEL SECURITY;

COMMIT;
