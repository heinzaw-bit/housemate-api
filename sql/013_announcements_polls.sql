-- Apply after 012_events.sql. Household communication remains in the private schema.
BEGIN;

CREATE TABLE housemate.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  priority text NOT NULL CHECK (priority IN ('normal', 'important', 'urgent')),
  requires_acknowledgement boolean NOT NULL,
  expires_at timestamptz,
  timezone text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (household_id, created_by_user_id, idempotency_key)
);
CREATE INDEX announcements_household_published_idx
  ON housemate.announcements (household_id, published_at DESC, id);

CREATE TABLE housemate.announcement_recipients (
  announcement_id uuid NOT NULL REFERENCES housemate.announcements(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  acknowledged_at timestamptz,
  PRIMARY KEY (announcement_id, member_id)
);
CREATE INDEX announcement_recipients_member_idx
  ON housemate.announcement_recipients (member_id, announcement_id);

CREATE TABLE housemate.polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 240),
  allow_multiple boolean NOT NULL,
  deadline timestamptz NOT NULL,
  timezone text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (household_id, created_by_user_id, idempotency_key),
  UNIQUE (id, allow_multiple)
);
CREATE INDEX polls_household_deadline_idx ON housemate.polls (household_id, deadline, id);

CREATE TABLE housemate.poll_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id uuid NOT NULL REFERENCES housemate.polls(id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 9),
  UNIQUE (poll_id, position),
  UNIQUE (poll_id, id)
);

CREATE TABLE housemate.poll_voters (
  poll_id uuid NOT NULL REFERENCES housemate.polls(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  PRIMARY KEY (poll_id, member_id)
);
CREATE INDEX poll_voters_member_idx ON housemate.poll_voters (member_id, poll_id);

CREATE TABLE housemate.poll_votes (
  poll_id uuid NOT NULL,
  member_id uuid NOT NULL,
  option_id uuid NOT NULL,
  allow_multiple boolean NOT NULL,
  voted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, member_id, option_id),
  FOREIGN KEY (poll_id, member_id) REFERENCES housemate.poll_voters(poll_id, member_id) ON DELETE RESTRICT,
  FOREIGN KEY (poll_id, option_id) REFERENCES housemate.poll_options(poll_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (poll_id, allow_multiple) REFERENCES housemate.polls(id, allow_multiple) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX poll_single_vote_idx ON housemate.poll_votes (poll_id, member_id)
  WHERE NOT allow_multiple;
CREATE INDEX poll_votes_option_idx ON housemate.poll_votes (poll_id, option_id);
CREATE INDEX poll_votes_member_idx ON housemate.poll_votes (member_id, poll_id);

ALTER TABLE housemate.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.announcement_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.poll_voters ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.poll_votes ENABLE ROW LEVEL SECURITY;

COMMIT;
