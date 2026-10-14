-- Phase 13: notification channels — email and webhooks.
--
--   Pages to people  ──► email (one notification row per person per step)
--   Incident events  ──► webhooks (one delivery row per subscribed endpoint)
--
--   POST https://hooks.example.com/fireline
--   Fireline-Event: incident.triggered
--   Fireline-Signature: t=1760430000,v1=<hex HMAC-SHA256(secret, "t.body")>
--   { "event": "incident.triggered",
--     "incident": { "id": "INC-142", "title": "Checkout API unavailable", "severity": "critical", ... } }
--
-- Both are outbox rows written in the same transaction as the change that
-- caused them, delivered by the worker with retries, and re-driven by the
-- sweeper if a queue job is lost.

-- Pages now go out by email (the old single Slack webhook is replaced by
-- per-organization webhook endpoints below).
ALTER TABLE notifications ALTER COLUMN channel SET DEFAULT 'email';
UPDATE notifications SET channel = 'email' WHERE channel = 'webhook';
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel IN ('email'));
-- SMTP Message-ID of the sent email, for tracing a page end to end.
ALTER TABLE notifications ADD COLUMN provider_message_id TEXT;

CREATE TABLE webhook_endpoints (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (url ~ '^https?://'),
  description TEXT NOT NULL DEFAULT '',
  -- Signing secret ("whsec_..."). Unlike API keys it can't be stored hashed:
  -- the worker needs it to compute each request's HMAC. Shown to the admin
  -- once, at creation or rotation.
  secret TEXT NOT NULL,
  -- Subscribed event types (see WEBHOOK_EVENTS in packages/shared/src/webhooks.ts).
  events TEXT[] NOT NULL CHECK (cardinality(events) > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- Why it was switched off automatically (e.g. the receiver answered 410 Gone).
  disabled_reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_org_idx ON webhook_endpoints (organization_id);

CREATE TABLE webhook_deliveries (
  id SERIAL PRIMARY KEY,
  endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id INTEGER REFERENCES incidents(id) ON DELETE CASCADE, -- NULL for "ping"
  event TEXT NOT NULL,
  -- The exact JSON body that is signed and sent; stored so a redelivery
  -- sends the same bytes and the receiver can dedupe on payload.id.
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  duration_ms INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, id DESC);
CREATE INDEX webhook_deliveries_queued_idx ON webhook_deliveries (created_at) WHERE status = 'queued';
