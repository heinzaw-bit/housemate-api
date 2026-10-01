-- Private bounded AI request counters. No prompts or conversation history.
BEGIN;
CREATE TABLE housemate.assistant_usage (
  bucket text PRIMARY KEY CHECK (length(bucket) BETWEEN 1 AND 100),
  requests integer NOT NULL CHECK (requests > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX assistant_usage_expiry_idx ON housemate.assistant_usage (expires_at);
ALTER TABLE housemate.assistant_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON housemate.assistant_usage FROM PUBLIC, anon, authenticated;
COMMIT;
