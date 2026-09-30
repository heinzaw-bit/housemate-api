-- Correct the notification trigger variable collision without changing applied migration 014.
BEGIN;
CREATE OR REPLACE FUNCTION housemate.capture_notification() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE hh uuid; eid uuid; et text; cat text; event_title text; detail text; event_kind text := 'created';
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
    event_title := CASE WHEN et = 'expense' THEN 'Expense ' ELSE 'Bill ' END || event_kind;
    detail := NEW.title;
    event_key := et || ':' || eid || ':' || NEW.revision;
  WHEN 'settlements' THEN
    hh := NEW.household_id; eid := NEW.id; et := 'settlement'; cat := 'settlements';
    people := ARRAY[NEW.sender_member_id,NEW.recipient_member_id];
    event_title := 'Manual transfer recorded'; detail := 'A member reported a transfer made outside HouseMate.';
  WHEN 'chores' THEN
    hh := NEW.household_id; eid := NEW.id; et := 'chore'; cat := 'chores'; detail := NEW.title;
    people := ARRAY[NEW.assignee_member_id];
    IF TG_OP = 'UPDATE' THEN
      IF NEW.assignee_member_id = OLD.assignee_member_id AND NEW.status = OLD.status THEN RETURN NEW; END IF;
      people := ARRAY[NEW.assignee_member_id, OLD.assignee_member_id];
      event_kind := CASE WHEN NEW.status = 'open' THEN 'reassigned' ELSE NEW.status END;
    ELSE event_kind := 'assigned'; END IF;
    event_title := 'Chore ' || event_kind; event_key := 'chore:' || eid || ':' || NEW.revision;
  WHEN 'chore_swap_requests' THEN
    SELECT household_id, title INTO source FROM housemate.chores WHERE id = NEW.chore_id;
    hh := source.household_id; eid := NEW.chore_id; et := 'chore'; cat := 'chores'; detail := source.title;
    people := CASE WHEN NEW.status = 'pending' THEN ARRAY[NEW.target_member_id] ELSE ARRAY[NEW.requested_by_member_id] END;
    IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN RETURN NEW; END IF;
    event_kind := 'swap_' || NEW.status; event_title := 'Chore swap ' || NEW.status;
    event_key := 'swap:' || NEW.id || ':' || NEW.status;
  WHEN 'shopping_items' THEN
    hh := NEW.household_id; eid := NEW.id; et := 'shopping'; cat := 'shopping'; pri := 'low'; detail := NEW.title;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.revision = OLD.revision THEN RETURN NEW; END IF;
      event_kind := NEW.status;
    ELSE event_kind := 'added'; END IF;
    event_title := 'Shopping item ' || event_kind; event_key := 'shopping:' || eid || ':' || NEW.revision;
  WHEN 'meal_participants' THEN
    SELECT household_id, question, response_deadline INTO source FROM housemate.meal_checks WHERE id = NEW.meal_id;
    hh := source.household_id; eid := NEW.meal_id; et := 'meal'; cat := 'meals'; people := ARRAY[NEW.member_id];
    event_title := 'Meal needs your reply'; detail := source.question; expiry := source.response_deadline;
  WHEN 'meal_cooking_roles' THEN
    SELECT household_id, question, starts_at INTO source FROM housemate.meal_checks WHERE id = NEW.meal_id;
    hh := source.household_id; eid := NEW.meal_id; et := 'meal'; cat := 'meals'; people := ARRAY[NEW.member_id];
    event_kind := 'cooking_role'; event_title := 'Cooking role assigned'; detail := NEW.role || ' · ' || source.question;
    expiry := source.starts_at; event_key := 'meal-role:' || eid || ':' || NEW.member_id || ':' || NEW.role;
  WHEN 'events' THEN
    hh := NEW.household_id; eid := NEW.id; et := 'event'; cat := 'events'; event_title := 'New household event'; detail := NEW.title; expiry := NEW.starts_at;
  WHEN 'announcement_recipients' THEN
    SELECT household_id,title,priority,expires_at INTO source FROM housemate.announcements WHERE id = NEW.announcement_id;
    hh := source.household_id; eid := NEW.announcement_id; et := 'announcement'; cat := 'announcements'; people := ARRAY[NEW.member_id];
    event_title := 'New announcement'; detail := source.title; pri := source.priority; expiry := source.expires_at;
  WHEN 'poll_voters' THEN
    SELECT household_id,question,deadline INTO source FROM housemate.polls WHERE id = NEW.poll_id;
    hh := source.household_id; eid := NEW.poll_id; et := 'poll'; cat := 'polls'; people := ARRAY[NEW.member_id];
    event_title := 'Poll needs your vote'; detail := source.question; expiry := source.deadline;
  ELSE RETURN NEW;
  END CASE;
  PERFORM housemate.emit_notification(hh,people,cat,pri,et,eid,event_kind,event_title,detail,
    COALESCE(event_key,et || ':' || eid || ':' || event_kind),expiry);
  RETURN NEW;
END;
$$;
COMMIT;
