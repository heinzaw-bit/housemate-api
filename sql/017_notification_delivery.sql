-- Additive diagnostics only; existing queues/subscriptions remain compatible.
ALTER TABLE housemate.push_deliveries ADD COLUMN IF NOT EXISTS queued_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE housemate.push_deliveries ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE housemate.push_subscriptions ADD COLUMN IF NOT EXISTS last_test_at timestamptz;
ALTER TABLE housemate.push_subscriptions ADD COLUMN IF NOT EXISTS last_test_status text CHECK (last_test_status IN ('sending','accepted','failed','invalid'));
ALTER TABLE housemate.push_subscriptions ADD COLUMN IF NOT EXISTS last_test_accepted_at timestamptz;
CREATE INDEX IF NOT EXISTS push_delivery_recent_attempt_idx ON housemate.push_deliveries(last_attempt_at) WHERE status IN ('failed','invalid');
