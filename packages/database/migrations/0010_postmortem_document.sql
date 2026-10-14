-- Phase 15: postmortems as a full document.
--
--   INC-142 POSTMORTEM
--   Incident · Duration · Severity · Impact
--   Timeline            ← curated from timeline_events (the immutable log)
--   Root cause · Resolution · What went well · What went poorly
--   Action items        ☐ Add DB connection alerts  (owner, due date)

ALTER TABLE postmortems ADD COLUMN what_went_well TEXT NOT NULL DEFAULT '';
ALTER TABLE postmortems ADD COLUMN what_went_poorly TEXT NOT NULL DEFAULT '';

-- The timeline becomes structured entries instead of pre-rendered Markdown:
--   [{ "eventId": 812, "hash": "9f2c…", "at": "...", "type": "NOTE_ADDED",
--      "message": "...", "actor": "Sam", "hidden": false }]
-- eventId + hash point back to the audit-log row each entry was taken from.
-- Times and wording are copied, never edited; responders can only hide an
-- entry from the document. Markdown is rendered on export.
ALTER TABLE postmortems ADD COLUMN timeline JSONB NOT NULL DEFAULT '[]';
ALTER TABLE postmortems DROP COLUMN timeline_markdown;

-- Publishing freezes the narrative (reopen as a draft to change it); action
-- items stay updatable so follow-up work can be ticked off afterwards.
ALTER TABLE postmortems ADD COLUMN published_at TIMESTAMPTZ;
ALTER TABLE postmortems ADD COLUMN published_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
UPDATE postmortems SET published_at = updated_at, published_by = updated_by WHERE status = 'published';

-- Action items get a stable id and an optional due date:
--   { "id": "ai_k3j9x0q2", "description": "...", "owner": "Sam", "dueDate": "2026-10-21", "done": false }
UPDATE postmortems SET action_items = COALESCE((
  SELECT jsonb_agg(item || jsonb_build_object(
    'id', 'ai_' || substr(md5(random()::text || ord::text), 1, 12),
    'dueDate', NULL))
  FROM jsonb_array_elements(action_items) WITH ORDINALITY AS t(item, ord)
), '[]'::jsonb);

ALTER TABLE timeline_events DROP CONSTRAINT timeline_events_event_type_check;
ALTER TABLE timeline_events ADD CONSTRAINT timeline_events_event_type_check CHECK (event_type IN (
  'INCIDENT_CREATED', 'ALERT_ATTACHED', 'ALERT_RESOLVED', 'NOTIFICATION_SENT', 'INCIDENT_ESCALATED',
  'ACK_TIMEOUT', 'INCIDENT_ACKNOWLEDGED', 'STATUS_CHANGED', 'SEVERITY_CHANGED', 'RESPONDER_ADDED',
  'COMMANDER_ASSIGNED', 'RESPONDER_ROLE_CHANGED', 'RESPONDER_REMOVED',
  'NOTE_ADDED', 'INCIDENT_RESOLVED', 'INCIDENT_REOPENED', 'POSTMORTEM_GENERATED', 'POSTMORTEM_PUBLISHED'
));
