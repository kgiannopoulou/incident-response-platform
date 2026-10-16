-- AI Incident Investigator: connect alerts, logs and deployments, and have
-- an agent construct an evidence-backed hypothesis and timeline.
--
--   monitoring ──POST /alerts──►  alerts
--   CI/CD ──────POST /deployments► deployments        ┐
--   apps ───────POST /logs───────► log_events         ├─► investigator (worker job)
--   admins ─────────────────────► service_dependencies┘      │ read-only tools over these,
--                                                            │ scoped to one organization
--                                                            ▼
--                                    incident_investigations: ranked hypotheses, each citing
--                                    evidence ids the tools actually returned; reconstructed
--                                    timeline; the agent's trace
--
-- The investigator never changes the incident. A responder may post a
-- hypothesis to the timeline as a note (an ordinary, attributed event).

-- What changed: deploys, config pushes, rollbacks — reported by CI/CD with the
-- service's API key.
CREATE TABLE deployments (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  api_key_id      INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  version         TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 100),
  commit_sha      TEXT CHECK (commit_sha ~ '^[0-9a-f]{7,40}$'),
  description     TEXT NOT NULL DEFAULT '',
  author          TEXT,
  environment     TEXT NOT NULL DEFAULT 'production',
  status          TEXT NOT NULL DEFAULT 'succeeded'
                  CHECK (status IN ('in_progress', 'succeeded', 'failed', 'rolled_back')),
  kind            TEXT NOT NULL DEFAULT 'deploy' CHECK (kind IN ('deploy', 'config', 'rollback', 'migration', 'feature_flag')),
  url             TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deployments_service_time ON deployments (service_id, started_at DESC);
CREATE INDEX deployments_org_time ON deployments (organization_id, started_at DESC);

-- Application logs, sent in batches. Only what an investigation needs: a
-- level, a message and a few attributes. `fingerprint` groups the same
-- message with its numbers/ids masked ("timeout after 5000ms for order 81"
-- and "... 5012ms for order 99" are one group), which is how the
-- investigator spots *new* error patterns.
CREATE TABLE log_events (
  id              BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
  message         TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  attributes      JSONB NOT NULL DEFAULT '{}',
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX log_events_service_time ON log_events (service_id, ts DESC);
CREATE INDEX log_events_service_fingerprint ON log_events (service_id, fingerprint, ts);

-- "checkout-api depends on postgres-primary": lets the investigator look
-- upstream when a service fails because something it calls is failing.
CREATE TABLE service_dependencies (
  service_id            INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  depends_on_service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, depends_on_service_id),
  CHECK (service_id <> depends_on_service_id)
);
CREATE INDEX service_dependencies_reverse ON service_dependencies (depends_on_service_id);

CREATE TABLE incident_investigations (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id     INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  provider        TEXT,          -- 'claude' (agent) or 'rules' (offline correlation, not AI)
  model           TEXT,          -- the model that actually answered (may be a fallback)
  findings        JSONB,         -- validated InvestigationFindings
  -- Every evidence item the investigator's tools returned, by id. Citations
  -- in `findings` are checked against this ledger: the agent can only cite
  -- what it actually looked at.
  evidence        JSONB NOT NULL DEFAULT '{}',
  steps           JSONB NOT NULL DEFAULT '[]',  -- tool calls made, in order (the trace)
  warnings        JSONB NOT NULL DEFAULT '[]',
  usage           JSONB,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);
CREATE INDEX incident_investigations_incident ON incident_investigations (incident_id, id DESC);
-- One investigation in flight per incident.
CREATE UNIQUE INDEX incident_investigations_one_running ON incident_investigations (incident_id)
  WHERE status IN ('queued', 'running');
