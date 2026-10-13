-- Incident Response Platform — initial schema.
--
-- Multi-tenant: every business table carries organization_id, and every API
-- query is scoped by the organization in the caller's JWT / integration key.
-- Timestamps are TIMESTAMPTZ throughout; ids are plain SERIALs except where
-- a public, per-organization number is useful (incidents.number).

CREATE TABLE organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  -- Last incident number handed out. Incrementing it with UPDATE ...
  -- RETURNING row-locks the organization, so concurrent incidents can never
  -- get the same INC-number.
  incident_counter INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL, -- bcrypt
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A user's role inside one organization.
--   admin     — manage services, teams, escalation policies, alert rules
--   responder — work incidents (acknowledge, resolve, notes, postmortems)
CREATE TABLE organization_members (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'responder')),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

-- Who gets paged, in what order. Level 1 is notified as soon as an incident
-- opens; each later level is notified `delay_minutes` after the previous
-- one if the incident still hasn't been acknowledged.
CREATE TABLE escalation_policies (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE escalation_rules (
  id SERIAL PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES escalation_policies(id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK (level >= 1),
  delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  target_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT escalation_rules_one_target CHECK (
    (target_user_id IS NOT NULL)::int + (target_team_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX escalation_rules_policy_idx ON escalation_rules (policy_id, level);

-- Something being monitored: "Checkout API", "PostgreSQL Primary"...
-- Monitoring tools authenticate alert ingestion with the service's
-- integration key; only its SHA-256 hash is stored.
CREATE TABLE services (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  escalation_policy_id INTEGER REFERENCES escalation_policies(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'operational'
    CHECK (status IN ('operational', 'degraded', 'outage', 'maintenance')),
  integration_key_hash TEXT NOT NULL UNIQUE,
  -- Resolve the incident automatically once every alert attached to it has
  -- been resolved by the monitoring tool.
  auto_resolve BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- Ordered matching rules evaluated against every incoming alert of a
-- service (see packages/shared/src/rules.ts). First match wins; when nothing
-- matches, the default rule applies (critical/error alerts open incidents,
-- warning/info are only recorded).
CREATE TABLE alert_rules (
  id SERIAL PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  -- [{ "field": "severity"|"source"|"summary"|"component", "op": "equals"|"contains"|"at_least", "value": "..." }]
  conditions JSONB NOT NULL DEFAULT '[]',
  action TEXT NOT NULL CHECK (action IN ('create_incident', 'suppress')),
  -- Optional severity override for incidents opened by this rule.
  incident_severity TEXT CHECK (incident_severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alert_rules_service_idx ON alert_rules (service_id, position);

CREATE TABLE incidents (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, -- human-facing "INC-42", unique per organization
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status TEXT NOT NULL DEFAULT 'triggered'
    CHECK (status IN ('triggered', 'acknowledged', 'investigating', 'resolved')),
  -- Alerts with the same dedup key are grouped into one open incident.
  dedup_key TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL = opened by an alert
  commander_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Highest escalation level already paged, and when the next level is
  -- due. The database is the source of truth for escalation: the worker
  -- sweeps for overdue rows, so a lost queue job only delays a page, never
  -- drops it. NULL = nothing left to escalate (acknowledged, resolved, or
  -- the policy has no more levels).
  escalation_level INTEGER NOT NULL DEFAULT 0,
  next_escalation_at TIMESTAMPTZ,
  alert_count INTEGER NOT NULL DEFAULT 0,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  UNIQUE (organization_id, number)
);
CREATE INDEX incidents_next_escalation_idx ON incidents (next_escalation_at)
  WHERE next_escalation_at IS NOT NULL;
CREATE INDEX incidents_org_status_idx ON incidents (organization_id, status, triggered_at DESC);
-- At most one *open* incident per service + dedup key. Concurrent duplicate
-- alerts race on this index instead of each opening their own incident.
CREATE UNIQUE INDEX incidents_open_dedup_idx
  ON incidents (service_id, dedup_key)
  WHERE status <> 'resolved' AND dedup_key IS NOT NULL;

-- Raw events received from monitoring tools.
CREATE TABLE alerts (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'error', 'warning', 'info')),
  source TEXT NOT NULL,
  component TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'firing' CHECK (status IN ('firing', 'resolved', 'suppressed')),
  -- Which rule decided what to do with it (NULL = default rule).
  matched_rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX alerts_service_dedup_idx ON alerts (service_id, dedup_key, status);
CREATE INDEX alerts_org_received_idx ON alerts (organization_id, received_at DESC);

CREATE TABLE incident_alerts (
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, alert_id)
);

CREATE TABLE incident_responders (
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'responder' CHECK (role IN ('commander', 'responder')),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, user_id)
);

-- Append-only story of one incident; the source for the live timeline view
-- and for the generated postmortem.
CREATE TABLE timeline_events (
  id SERIAL PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL = system
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX timeline_events_incident_idx ON timeline_events (incident_id, created_at, id);

-- One row per page/message sent to a responder; the worker delivers them.
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('triggered', 'escalated', 'acknowledged', 'resolved')),
  channel TEXT NOT NULL DEFAULT 'webhook',
  escalation_level INTEGER,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX notifications_incident_idx ON notifications (incident_id);
-- One page per person per escalation level per incident, even if the
-- escalation job is retried.
CREATE UNIQUE INDEX notifications_once_per_level_idx
  ON notifications (incident_id, user_id, kind, escalation_level);

CREATE TABLE postmortems (
  id SERIAL PRIMARY KEY,
  incident_id INTEGER NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  summary TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL DEFAULT '',
  root_cause TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',
  -- [{ "description": "...", "owner": "...", "done": false }]
  action_items JSONB NOT NULL DEFAULT '[]',
  -- Metrics + timeline captured when the draft was generated.
  metrics JSONB NOT NULL DEFAULT '{}',
  timeline_markdown TEXT NOT NULL DEFAULT '',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Organization-wide audit trail: every mutation through the API (and every
-- automated action) records who did what to which entity.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL = system / integration
  action TEXT NOT NULL, -- e.g. "incident.acknowledge", "service.create"
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (organization_id, created_at DESC);
