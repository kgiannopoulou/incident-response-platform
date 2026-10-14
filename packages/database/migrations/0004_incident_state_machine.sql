-- Phase 6: the incident state machine.
--
--   triggered ──► acknowledged ──► investigating ──► mitigated ──► resolved
--   (plus shortcuts to resolved from every open state; resolved is final)
--
-- The API validates every move against INCIDENT_TRANSITIONS in
-- packages/shared/src/lifecycle.ts. This trigger enforces the same table
-- inside the database, so a hand-written UPDATE, a script or a future code
-- path that forgets to call changeStatus() still can't produce nonsense such
-- as resolved -> acknowledged. A test checks that both tables agree for
-- every (from, to) pair.

ALTER TABLE incidents DROP CONSTRAINT incidents_status_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_status_check
  CHECK (status IN ('triggered', 'acknowledged', 'investigating', 'mitigated', 'resolved'));

-- When customer impact stopped. Set on 'mitigated', or on 'resolved' if the
-- incident skipped straight there; drives time-to-mitigate.
ALTER TABLE incidents ADD COLUMN mitigated_at TIMESTAMPTZ;
UPDATE incidents SET mitigated_at = resolved_at WHERE status = 'resolved';

CREATE FUNCTION incident_transition_allowed(from_status TEXT, to_status TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT (from_status, to_status) IN (
    ('triggered', 'acknowledged'), ('triggered', 'resolved'),
    ('acknowledged', 'investigating'), ('acknowledged', 'resolved'),
    ('investigating', 'mitigated'), ('investigating', 'resolved'),
    ('mitigated', 'resolved')
  );
$$;

CREATE FUNCTION enforce_incident_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT incident_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'Invalid incident transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER incidents_status_transition
  BEFORE UPDATE OF status ON incidents
  FOR EACH ROW EXECUTE FUNCTION enforce_incident_transition();
