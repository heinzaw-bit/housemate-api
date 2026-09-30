-- Private notification feed and durable push queue. Apply after migration 013.
BEGIN;
CREATE TABLE housemate.notification_preferences (
  member_id uuid PRIMARY KEY REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  categories jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(categories) = 'object'),
  quiet_enabled boolean NOT NULL DEFAULT false,
  quiet_start time NOT NULL DEFAULT '23:00',
  quiet_end time NOT NULL DEFAULT '07:00',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (quiet_start <> quiet_end)
);
CREATE TABLE housemate.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES housemate.households(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES housemate.household_members(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('money','bills','settlements','meals','chores','shopping','events','announcements','polls')),
  priority text NOT NULL CHECK (priority IN ('low','normal','important','urgent')),
  entity_type text NOT NULL CHECK (entity_type IN ('expense','bill','settlement','meal','chore','shopping','event','announcement','poll')),
  entity_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 500),
  event_key text NOT NULL,
  in_app boolean NOT NULL,
  push_requested boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  read_at timestamptz,
  UNIQUE (member_id, event_key)
);
CREATE INDEX notifications_feed_idx ON housemate.notifications (member_id, created_at DESC, id DESC) WHERE in_app;
CREATE INDEX notifications_unread_idx ON housemate.notifications (member_id, created_at DESC, id DESC) WHERE in_app AND read_at IS NULL;
CREATE TABLE housemate.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES housemate.users(id) ON DELETE RESTRICT,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  vapid_public_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  last_error text
);
CREATE INDEX push_subscriptions_user_idx ON housemate.push_subscriptions (user_id) WHERE enabled;
CREATE TABLE housemate.push_deliveries (
  notification_id uuid NOT NULL REFERENCES housemate.notifications(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES housemate.push_subscriptions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','skipped','invalid')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  leased_until timestamptz,
  sent_at timestamptz,
  last_error text,
  PRIMARY KEY (notification_id, subscription_id)
);
CREATE INDEX push_deliveries_ready_idx ON housemate.push_deliveries (available_at) WHERE status IN ('pending','processing');
ALTER TABLE housemate.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE housemate.push_deliveries ENABLE ROW LEVEL SECURITY;

-- Invoker functions stay private. Only the trusted API connection can use them.
CREATE FUNCTION housemate.emit_notification(hh uuid, recipients uuid[], cat text, pri text, et text, eid uuid,
  event_kind text, event_title text, event_body text, event_key text, expiry timestamptz DEFAULT NULL)
RETURNS void LANGUAGE sql SET search_path = '' AS $$
  INSERT INTO housemate.notifications (household_id, member_id, category, priority, entity_type, entity_id,
    kind, title, body, event_key, in_app, push_requested, expires_at)
  SELECT hh, m.id, cat, pri, et, eid, event_kind, left(event_title,200), left(event_body,500), event_key,
    COALESCE((p.categories -> cat ->> 'inApp')::boolean, true),
    COALESCE((p.categories -> cat ->> 'webPush')::boolean, cat <> 'shopping'),
    COALESCE(expiry, now() + interval '7 days')
  FROM housemate.household_members m JOIN housemate.households h ON h.id = m.household_id
  LEFT JOIN housemate.notification_preferences p ON p.member_id = m.id
  WHERE m.household_id = hh AND m.status = 'active' AND h.archived_at IS NULL
    AND (recipients IS NULL OR m.id = ANY(recipients))
  ON CONFLICT (member_id, event_key) DO NOTHING;
$$;

CREATE FUNCTION housemate.capture_notification() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE hh uuid; eid uuid; et text; cat text; title text; detail text; event_kind text := 'created';
  pri text := 'normal'; people uuid[]; expiry timestamptz; event_key text; source record;
BEGIN
  CASE TG_TABLE_NAME
  WHEN 'expenses', 'bills' THEN
    hh := NEW.household_id; eid := NEW.id;
    et := CASE WHEN TG_TABLE_NAME = 'expenses' THEN 'expense' ELSE 'bill' END;
    cat := CASE WHEN et = 'expense' THEN 'money' ELSE 'bills' END;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.revision = OLD.revision THEN RETURN NEW; END IF;
      event_kind := CASE WHEN NEW.voided_at IS NOT NULL THEN 'voided' ELSE 'updated' END;
    END IF;
    title := CASE WHEN et = 'expense' THEN 'Expense ' ELSE 'Bill ' END || event_kind;
    detail := NEW.title;
    event_key := et || ':' || eid || ':' || NEW.revision;
  WHEN 'settlements' THEN
    hh := NEW.household_id; eid := NEW.id; et := 'settlement'; cat := 'settlements';
    people := ARRAY[NEW.sender_member_id,NEW.recipient_member_id];
    title := 'Manual transfer recorded'; detail := 'A member reported a transfer made outside HouseMate.';
  WHEN 'chores' THEN
    hh := NEW.household_id; eid := NEW.id; et := 'chore'; cat := 'chores'; detail := NEW.title;
    people := ARRAY[NEW.assignee_member_id];
    IF TG_OP = 'UPDATE' THEN
      IF NEW.assignee_member_id = OLD.assignee_member_id AND NEW.status = OLD.status THEN RETURN NEW; END IF;
      people := ARRAY[NEW.assignee_member_id, OLD.assignee_member_id];
      event_kind := CASE WHEN NEW.status = 'open' THEN 'reassigned' ELSE NEW.status END;
    ELSE event_kind := 'assigned'; END IF;
    title := 'Chore ' || event_kind; event_key := 'chore:' || eid || ':' || NEW.revision;
  WHEN 'chore_swap_requests' THEN
    SELECT household_id, title INTO source FROM housemate.chores WHERE id = NEW.chore_id;
    hh := source.household_id; eid := NEW.chore_id; et := 'chore'; cat := 'chores'; detail := source.title;
    people := CASE WHEN NEW.status = 'pending' THEN ARRAY[NEW.target_member_id] ELSE ARRAY[NEW.requested_by_member_id] END;
    IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN RETURN NEW; END IF;
    event_kind := 'swap_' || NEW.status; title := 'Chore swap ' || NEW.status;
    event_key := 'swap:' || NEW.id || ':' || NEW.status;
  WHEN 'shopping_items' THEN
    hh := NEW.household_id; eid := NEW.id; et := 'shopping'; cat := 'shopping'; pri := 'low'; detail := NEW.title;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.revision = OLD.revision THEN RETURN NEW; END IF;
      event_kind := NEW.status;
    ELSE event_kind := 'added'; END IF;
    title := 'Shopping item ' || event_kind; event_key := 'shopping:' || eid || ':' || NEW.revision;
  WHEN 'meal_participants' THEN
    SELECT household_id, question, response_deadline INTO source FROM housemate.meal_checks WHERE id = NEW.meal_id;
    hh := source.household_id; eid := NEW.meal_id; et := 'meal'; cat := 'meals'; people := ARRAY[NEW.member_id];
    title := 'Meal needs your reply'; detail := source.question; expiry := source.response_deadline;
  WHEN 'meal_cooking_roles' THEN
    SELECT household_id, question, starts_at INTO source FROM housemate.meal_checks WHERE id = NEW.meal_id;
    hh := source.household_id; eid := NEW.meal_id; et := 'meal'; cat := 'meals'; people := ARRAY[NEW.member_id];
    event_kind := 'cooking_role'; title := 'Cooking role assigned'; detail := NEW.role || ' · ' || source.question;
    expiry := source.starts_at; event_key := 'meal-role:' || eid || ':' || NEW.member_id || ':' || NEW.role;
  WHEN 'events' THEN
    hh := NEW.household_id; eid := NEW.id; et := 'event'; cat := 'events'; title := 'New household event'; detail := NEW.title; expiry := NEW.starts_at;
  WHEN 'announcement_recipients' THEN
    SELECT household_id,title,priority,expires_at INTO source FROM housemate.announcements WHERE id = NEW.announcement_id;
    hh := source.household_id; eid := NEW.announcement_id; et := 'announcement'; cat := 'announcements'; people := ARRAY[NEW.member_id];
    title := 'New announcement'; detail := source.title; pri := source.priority; expiry := source.expires_at;
  WHEN 'poll_voters' THEN
    SELECT household_id,question,deadline INTO source FROM housemate.polls WHERE id = NEW.poll_id;
    hh := source.household_id; eid := NEW.poll_id; et := 'poll'; cat := 'polls'; people := ARRAY[NEW.member_id];
    title := 'Poll needs your vote'; detail := source.question; expiry := source.deadline;
  ELSE RETURN NEW;
  END CASE;
  PERFORM housemate.emit_notification(hh,people,cat,pri,et,eid,event_kind,title,detail,
    COALESCE(event_key,et || ':' || eid || ':' || event_kind),expiry);
  RETURN NEW;
END;
$$;
CREATE TRIGGER notifications_expenses AFTER INSERT OR UPDATE ON housemate.expenses FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_bills AFTER INSERT OR UPDATE ON housemate.bills FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_settlements AFTER INSERT ON housemate.settlements FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_chores AFTER INSERT OR UPDATE ON housemate.chores FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_swaps AFTER INSERT OR UPDATE ON housemate.chore_swap_requests FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_shopping AFTER INSERT OR UPDATE ON housemate.shopping_items FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_meals AFTER INSERT ON housemate.meal_participants FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_cooking AFTER INSERT ON housemate.meal_cooking_roles FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_events AFTER INSERT ON housemate.events FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_announcements AFTER INSERT ON housemate.announcement_recipients FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();
CREATE TRIGGER notifications_polls AFTER INSERT ON housemate.poll_voters FOR EACH ROW EXECUTE FUNCTION housemate.capture_notification();

CREATE FUNCTION housemate.generate_notification_reminders() RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r record; stage text; today date;
BEGIN
  FOR r IN SELECT b.*,h.timezone FROM housemate.bills b JOIN housemate.households h ON h.id = b.household_id
    WHERE b.payment_status = 'unpaid' AND b.voided_at IS NULL AND h.archived_at IS NULL
      AND b.due_date <= (now() AT TIME ZONE h.timezone)::date + 2 LOOP
    today := (now() AT TIME ZONE r.timezone)::date;
    stage := CASE WHEN r.due_date < today THEN 'overdue' WHEN r.due_date = today THEN 'due_today' ELSE 'due_soon' END;
    PERFORM housemate.emit_notification(r.household_id,
      ARRAY(SELECT member_id FROM housemate.bill_shares WHERE bill_id = r.id),'bills','important','bill',r.id,
      'reminder','Bill ' || replace(stage,'_',' '),r.title,'bill:' || r.id || ':reminder:' || stage || ':' || r.due_date);
  END LOOP;
  FOR r IN SELECT * FROM housemate.meal_checks WHERE response_deadline > now() AND response_deadline <= now() + interval '1 hour' LOOP
    PERFORM housemate.emit_notification(r.household_id,ARRAY(SELECT member_id FROM housemate.meal_participants WHERE meal_id = r.id AND response IS NULL),
      'meals','normal','meal',r.id,'reminder','Meal reply closes soon',r.question,'meal:' || r.id || ':deadline-reminder',r.response_deadline);
  END LOOP;
  FOR r IN SELECT * FROM housemate.chores WHERE status = 'open' AND due_at <= now() + interval '1 day' LOOP
    stage := CASE WHEN r.due_at <= now() THEN 'overdue' ELSE 'due_soon' END;
    PERFORM housemate.emit_notification(r.household_id,ARRAY[r.assignee_member_id],'chores','normal','chore',r.id,'reminder',
      'Chore ' || replace(stage,'_',' '),r.title,'chore:' || r.id || ':' || r.assignee_member_id || ':reminder:' || stage || ':' || r.due_at);
  END LOOP;
  FOR r IN SELECT * FROM housemate.events WHERE starts_at > now() AND starts_at <= now() + interval '1 day' LOOP
    PERFORM housemate.emit_notification(r.household_id,ARRAY(SELECT m.id FROM housemate.household_members m LEFT JOIN housemate.event_attendance a ON a.member_id=m.id AND a.event_id=r.id
      WHERE m.household_id=r.household_id AND m.status='active' AND (a.response IS NULL OR a.response IN ('going','maybe'))),
      'events','normal','event',r.id,'reminder','Event starts soon',r.title,'event:' || r.id || ':start-reminder',r.starts_at);
  END LOOP;
  FOR r IN SELECT * FROM housemate.polls WHERE deadline > now() AND deadline <= now() + interval '1 hour' LOOP
    PERFORM housemate.emit_notification(r.household_id,ARRAY(SELECT member_id FROM housemate.poll_voters v WHERE poll_id=r.id
      AND NOT EXISTS(SELECT 1 FROM housemate.poll_votes x WHERE x.poll_id=v.poll_id AND x.member_id=v.member_id)),
      'polls','normal','poll',r.id,'reminder','Poll closes soon',r.question,'poll:' || r.id || ':deadline-reminder',r.deadline);
  END LOOP;
  FOR r IN SELECT * FROM housemate.announcements WHERE requires_acknowledgement AND expires_at > now() AND expires_at <= now() + interval '1 day' LOOP
    PERFORM housemate.emit_notification(r.household_id,ARRAY(SELECT member_id FROM housemate.announcement_recipients WHERE announcement_id=r.id AND acknowledged_at IS NULL),
      'announcements',r.priority,'announcement',r.id,'reminder','Announcement acknowledgement closes soon',r.title,'announcement:' || r.id || ':expiry-reminder',r.expires_at);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION housemate.emit_notification(uuid,uuid[],text,text,text,uuid,text,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION housemate.capture_notification() FROM PUBLIC;
REVOKE ALL ON FUNCTION housemate.generate_notification_reminders() FROM PUBLIC;
COMMIT;
