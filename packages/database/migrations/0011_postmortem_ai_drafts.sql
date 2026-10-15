-- Phase 16: AI-assisted postmortem drafts, as suggestions a person reviews.
--
--   "Generate AI draft" ──► postmortem_ai_drafts row (queued) ──► worker job
--        ──► model output, validated (citations checked against the event log)
--        ──► ready: the reviewer applies chosen sections to the postmortem,
--            edits them, and confirms the review before publishing.
--
-- The draft is kept separately from the postmortem, so what the model
-- suggested, what it was given (input_digest) and who applied which section
-- stay on record after people rewrite the text.

CREATE TABLE postmortem_ai_drafts (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id     INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'generating', 'ready', 'failed', 'applied', 'discarded')),
  provider        TEXT,          -- 'claude' or 'rules' (offline fallback, not AI)
  model           TEXT,          -- the model that actually answered (may be a fallback model)
  -- sha256 of the exact (redacted) context sent, and how many timeline
  -- events it covered: answers "what did the model see?" later on.
  input_digest    TEXT,
  input_events    INTEGER,
  output          JSONB,         -- validated sections (AiPostmortemOutput)
  warnings        JSONB NOT NULL DEFAULT '[]',
  usage           JSONB,         -- token usage reported by the provider
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  applied_sections TEXT[] NOT NULL DEFAULT '{}',
  requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  reviewed_at     TIMESTAMPTZ
);

CREATE INDEX postmortem_ai_drafts_incident ON postmortem_ai_drafts (incident_id, id DESC);
-- One generation in flight per incident: a second click while the first
-- is running gets a 409 instead of paying for the same draft twice.
CREATE UNIQUE INDEX postmortem_ai_drafts_one_active ON postmortem_ai_drafts (incident_id)
  WHERE status IN ('queued', 'generating');

-- Which sections of the postmortem were seeded from an AI draft, and
-- whether a person has confirmed reviewing them. Publishing is refused
-- while ai_review_pending is true.
ALTER TABLE postmortems ADD COLUMN ai_assisted_sections TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE postmortems ADD COLUMN ai_review_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE postmortems ADD COLUMN ai_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE postmortems ADD COLUMN ai_reviewed_at TIMESTAMPTZ;
