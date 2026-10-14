-- Phase 10: responders and their roles.
--
--   INC-142
--   Incident Commander  Konstantina   — owns the incident, coordinates, decides
--   Responders          Maria, George — hands on keyboard
--   Observers           Alex          — follow along (support, management), read-only
--
-- incident_responders (incident_id, user_id, role, joined_at)

ALTER TABLE incident_responders RENAME COLUMN added_at TO joined_at;

ALTER TABLE incident_responders DROP CONSTRAINT incident_responders_role_check;
ALTER TABLE incident_responders ADD CONSTRAINT incident_responders_role_check
  CHECK (role IN ('commander', 'responder', 'observer'));

-- An incident has at most one commander. Handing over command demotes the
-- previous commander in the same transaction; this index makes "two
-- commanders" impossible even if two hand-overs race.
CREATE UNIQUE INDEX incident_responders_one_commander_idx
  ON incident_responders (incident_id) WHERE role = 'commander';

-- Timeline vocabulary for role changes and people leaving.
ALTER TABLE timeline_events DROP CONSTRAINT timeline_events_event_type_check;
ALTER TABLE timeline_events ADD CONSTRAINT timeline_events_event_type_check CHECK (event_type IN (
  'INCIDENT_CREATED', 'ALERT_ATTACHED', 'ALERT_RESOLVED', 'NOTIFICATION_SENT', 'INCIDENT_ESCALATED',
  'INCIDENT_ACKNOWLEDGED', 'STATUS_CHANGED', 'SEVERITY_CHANGED', 'RESPONDER_ADDED', 'COMMANDER_ASSIGNED',
  'RESPONDER_ROLE_CHANGED', 'RESPONDER_REMOVED',
  'NOTE_ADDED', 'INCIDENT_RESOLVED', 'INCIDENT_REOPENED', 'POSTMORTEM_GENERATED'
));
