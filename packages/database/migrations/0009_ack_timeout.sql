-- Phase 14: acknowledgement timeout.
--
--   Incident created (SEV1)
--         │
--         ▼
--   wait ack_timeout_minutes (delayed BullMQ job "ack-timeout")
--         │
--         ▼
--   acknowledged? ── yes ──► stop (acknowledging clears the deadline and cancels the job)
--         │ no
--         ▼
--   escalate now: page the next step without waiting for its delay
--
-- The escalation policy's steps are the normal schedule; the
-- acknowledgement timeout is a fast lane for high-urgency incidents (SEV1 /
-- SEV2): if nobody owns one within N minutes, the next step is paged
-- immediately. Low-urgency incidents follow the steps only.

-- NULL = no acknowledgement timeout for this policy.
ALTER TABLE escalation_policies ADD COLUMN ack_timeout_minutes INTEGER
  CHECK (ack_timeout_minutes BETWEEN 1 AND 1440);

-- When the timeout fires (NULL = none pending), and when it last did. As
-- with next_escalation_at, Postgres is the source of truth: the delayed job
-- is the fast path, the worker's sweeper catches any deadline a lost job
-- missed.
ALTER TABLE incidents ADD COLUMN ack_deadline_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN ack_timed_out_at TIMESTAMPTZ;
CREATE INDEX incidents_ack_deadline_idx ON incidents (ack_deadline_at) WHERE ack_deadline_at IS NOT NULL;

ALTER TABLE timeline_events DROP CONSTRAINT timeline_events_event_type_check;
ALTER TABLE timeline_events ADD CONSTRAINT timeline_events_event_type_check CHECK (event_type IN (
  'INCIDENT_CREATED', 'ALERT_ATTACHED', 'ALERT_RESOLVED', 'NOTIFICATION_SENT', 'INCIDENT_ESCALATED',
  'ACK_TIMEOUT', 'INCIDENT_ACKNOWLEDGED', 'STATUS_CHANGED', 'SEVERITY_CHANGED', 'RESPONDER_ADDED',
  'COMMANDER_ASSIGNED', 'RESPONDER_ROLE_CHANGED', 'RESPONDER_REMOVED',
  'NOTE_ADDED', 'INCIDENT_RESOLVED', 'INCIDENT_REOPENED', 'POSTMORTEM_GENERATED'
));
