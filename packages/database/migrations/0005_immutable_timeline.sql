-- Phase 8: an immutable, append-only incident timeline.
--
-- Every important action is a timeline event:
--
--   { "eventType": "STATUS_CHANGED", "metadata": { "from": "triggered", "to": "investigating" } }
--
-- and the timeline is treated as an audit log: rows can be inserted, never
-- edited or deleted. Three layers make that hold:
--
--   1. The API has no endpoint that updates or deletes timeline events.
--   2. Triggers reject UPDATE and DELETE on timeline_events for everyone,
--      including someone with a SQL prompt. (Deleting a whole incident still
--      cascades to its events: the DELETE guard only fires while the parent
--      incident exists.)
--   3. A hash chain makes tampering *evident* even for someone who can
--      disable triggers: each event stores sha256(previous hash + its own
--      content), so editing or removing any event breaks every hash after it.
--      timeline_verify(incident_id) recomputes the chain.

-- ---------------------------------------------------------------------------
-- Vocabulary: SCREAMING_SNAKE_CASE event types and plan-aligned column names.
-- ---------------------------------------------------------------------------

ALTER TABLE timeline_events RENAME COLUMN type TO event_type;
ALTER TABLE timeline_events RENAME COLUMN actor_user_id TO actor_id;

UPDATE timeline_events SET event_type = CASE event_type
  WHEN 'incident_created' THEN 'INCIDENT_CREATED'
  WHEN 'alert_attached' THEN 'ALERT_ATTACHED'
  WHEN 'alert_resolved' THEN 'ALERT_RESOLVED'
  WHEN 'notified' THEN 'NOTIFICATION_SENT'
  WHEN 'escalated' THEN 'INCIDENT_ESCALATED'
  WHEN 'acknowledged' THEN 'INCIDENT_ACKNOWLEDGED'
  WHEN 'status_changed' THEN 'STATUS_CHANGED'
  WHEN 'severity_changed' THEN 'SEVERITY_CHANGED'
  WHEN 'responder_added' THEN 'RESPONDER_ADDED'
  WHEN 'commander_assigned' THEN 'COMMANDER_ASSIGNED'
  WHEN 'note' THEN 'NOTE_ADDED'
  WHEN 'resolved' THEN 'INCIDENT_RESOLVED'
  WHEN 'reopened' THEN 'INCIDENT_REOPENED' -- historical only: reopening was removed in 0004
  WHEN 'postmortem_generated' THEN 'POSTMORTEM_GENERATED'
  ELSE event_type END;

ALTER TABLE timeline_events ADD CONSTRAINT timeline_events_event_type_check CHECK (event_type IN (
  'INCIDENT_CREATED', 'ALERT_ATTACHED', 'ALERT_RESOLVED', 'NOTIFICATION_SENT', 'INCIDENT_ESCALATED',
  'INCIDENT_ACKNOWLEDGED', 'STATUS_CHANGED', 'SEVERITY_CHANGED', 'RESPONDER_ADDED', 'COMMANDER_ASSIGNED',
  'NOTE_ADDED', 'INCIDENT_RESOLVED', 'INCIDENT_REOPENED', 'POSTMORTEM_GENERATED'
));

-- ---------------------------------------------------------------------------
-- Hash chain. Events are chained per incident in id (= insertion) order.
-- ---------------------------------------------------------------------------

ALTER TABLE timeline_events ADD COLUMN prev_hash TEXT;
ALTER TABLE timeline_events ADD COLUMN hash TEXT;

-- The canonical content of an event. created_at is rendered in UTC with
-- microseconds so the digest doesn't depend on the session's time zone;
-- metadata uses jsonb's normalized text form.
CREATE FUNCTION timeline_event_digest(
  prev TEXT, incident INTEGER, event_type TEXT, actor INTEGER, message TEXT, metadata JSONB, created TIMESTAMPTZ
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f',
    coalesce(prev, ''), incident::text, event_type, coalesce(actor::text, ''), message, metadata::text,
    to_char(created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
$$;

-- Backfill existing events, oldest first per incident.
DO $$
DECLARE
  e RECORD;
  last_incident INTEGER := NULL;
  last_hash TEXT := NULL;
BEGIN
  FOR e IN SELECT * FROM timeline_events ORDER BY incident_id, id LOOP
    IF last_incident IS DISTINCT FROM e.incident_id THEN
      last_hash := NULL;
      last_incident := e.incident_id;
    END IF;
    UPDATE timeline_events SET prev_hash = last_hash,
      hash = timeline_event_digest(last_hash, e.incident_id, e.event_type, e.actor_id, e.message, e.metadata, e.created_at)
    WHERE id = e.id;
    last_hash := timeline_event_digest(last_hash, e.incident_id, e.event_type, e.actor_id, e.message, e.metadata, e.created_at);
  END LOOP;
END $$;

ALTER TABLE timeline_events ALTER COLUMN hash SET NOT NULL;

-- Links each new event to the incident's latest one. Appends to one
-- incident are serialized by locking the incident row (the API and worker
-- already hold that lock when they write; taking it again is a no-op), so
-- two concurrent events can't both claim the same predecessor.
CREATE FUNCTION timeline_events_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM incidents WHERE id = NEW.incident_id FOR UPDATE;
  SELECT hash INTO NEW.prev_hash FROM timeline_events
    WHERE incident_id = NEW.incident_id ORDER BY id DESC LIMIT 1;
  NEW.hash := timeline_event_digest(NEW.prev_hash, NEW.incident_id, NEW.event_type, NEW.actor_id,
                                    NEW.message, NEW.metadata, NEW.created_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER timeline_events_chain
  BEFORE INSERT ON timeline_events
  FOR EACH ROW EXECUTE FUNCTION timeline_events_chain();

-- ---------------------------------------------------------------------------
-- Append-only.
-- ---------------------------------------------------------------------------

CREATE FUNCTION timeline_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM incidents WHERE id = OLD.incident_id) THEN
    RETURN OLD; -- the incident itself is being deleted (ON DELETE CASCADE)
  END IF;
  RAISE EXCEPTION 'timeline_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Record a correction as a new event (e.g. NOTE_ADDED) instead of editing history.';
END;
$$;

CREATE TRIGGER timeline_events_no_update
  BEFORE UPDATE ON timeline_events
  FOR EACH ROW EXECUTE FUNCTION timeline_events_immutable();

CREATE TRIGGER timeline_events_no_delete
  BEFORE DELETE ON timeline_events
  FOR EACH ROW EXECUTE FUNCTION timeline_events_immutable();

-- Recomputes an incident's chain. Returns one row: whether it is intact,
-- how many events were checked, and the first event id that doesn't match
-- (edited content, a removed predecessor, or a reordered link).
CREATE FUNCTION timeline_verify(incident INTEGER)
RETURNS TABLE (valid BOOLEAN, events INTEGER, first_invalid_id INTEGER) LANGUAGE plpgsql STABLE AS $$
DECLARE
  e RECORD;
  expected_prev TEXT := NULL;
  n INTEGER := 0;
BEGIN
  FOR e IN SELECT * FROM timeline_events t WHERE t.incident_id = incident ORDER BY t.id LOOP
    n := n + 1;
    IF e.prev_hash IS DISTINCT FROM expected_prev
       OR e.hash <> timeline_event_digest(e.prev_hash, e.incident_id, e.event_type, e.actor_id,
                                          e.message, e.metadata, e.created_at) THEN
      RETURN QUERY SELECT false, n, e.id;
      RETURN;
    END IF;
    expected_prev := e.hash;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::INTEGER;
END;
$$;
