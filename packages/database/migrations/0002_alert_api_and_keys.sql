-- Phase 3 (alert API contract) and Phase 4 (API key management).

-- ---------------------------------------------------------------------------
-- Alerts: public ids, the INFO / WARNING / HIGH / CRITICAL severity scale,
-- and field names matching the public API (title, description, metadata).
-- ---------------------------------------------------------------------------

ALTER TABLE alerts RENAME COLUMN summary TO title;
ALTER TABLE alerts RENAME COLUMN details TO metadata;
ALTER TABLE alerts ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE alerts DROP COLUMN component; -- not part of the API; use metadata

-- "error" becomes "high".
ALTER TABLE alerts DROP CONSTRAINT alerts_severity_check;
UPDATE alerts SET severity = 'high' WHERE severity = 'error';
ALTER TABLE alerts ADD CONSTRAINT alerts_severity_check
  CHECK (severity IN ('critical', 'high', 'warning', 'info'));

-- An alert that is still active is "triggered" (was "firing").
ALTER TABLE alerts DROP CONSTRAINT alerts_status_check;
UPDATE alerts SET status = 'triggered' WHERE status = 'firing';
ALTER TABLE alerts ADD CONSTRAINT alerts_status_check
  CHECK (status IN ('triggered', 'resolved', 'suppressed'));
ALTER TABLE alerts ALTER COLUMN status SET DEFAULT 'triggered';

-- Public, non-guessable, time-sortable id returned by the API:
-- "alert_" + ULID. Existing rows get a zero-padded placeholder of the same shape.
ALTER TABLE alerts ADD COLUMN public_id TEXT;
UPDATE alerts SET public_id = 'alert_' || lpad(id::text, 26, '0');
ALTER TABLE alerts ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE alerts ADD CONSTRAINT alerts_public_id_key UNIQUE (public_id);

-- Matching rules follow the renames: severity "error" -> "high", field
-- "summary" -> "title", field "component" -> "description".
UPDATE alert_rules SET conditions = (
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN c->>'field' = 'severity' AND c->>'value' = 'error' THEN jsonb_set(c, '{value}', '"high"')
      WHEN c->>'field' = 'summary' THEN jsonb_set(c, '{field}', '"title"')
      WHEN c->>'field' = 'component' THEN jsonb_set(c, '{field}', '"description"')
      ELSE c
    END), '[]'::jsonb)
  FROM jsonb_array_elements(conditions) c
);

-- ---------------------------------------------------------------------------
-- Services get a slug: the "service" field of the alert API ("checkout-api").
-- ---------------------------------------------------------------------------

ALTER TABLE services ADD COLUMN slug TEXT;
UPDATE services SET slug = trim(BOTH '-' FROM lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')));
ALTER TABLE services ALTER COLUMN slug SET NOT NULL;
ALTER TABLE services ADD CONSTRAINT services_org_slug_key UNIQUE (organization_id, slug);

-- ---------------------------------------------------------------------------
-- API keys: several per service, so a key can be rotated with an overlap
-- window and revoked without touching the others. Only the SHA-256 hash of
-- each key is stored; `prefix` ("ir_live_a8f83e7c") is kept so people can
-- tell keys apart in the UI and logs without the secret.
-- ---------------------------------------------------------------------------

CREATE TABLE api_keys (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  -- Token bucket size: requests per minute, with bursts up to the same number.
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 120
    CHECK (rate_limit_per_minute BETWEEN 1 AND 100000),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Updated at most once a minute per key (see apps/api/src/lib/api-keys.ts).
  last_used_at TIMESTAMPTZ,
  -- Set on rotation: the old key keeps working until then, so senders can
  -- switch to the new key without dropping alerts.
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  replaced_by_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL
);
CREATE INDEX api_keys_service_idx ON api_keys (service_id);

-- Existing integration keys keep working: same SHA-256 hashing.
INSERT INTO api_keys (organization_id, service_id, name, prefix, key_hash)
SELECT organization_id, id, 'Migrated key', 'legacy', integration_key_hash FROM services;

ALTER TABLE services DROP COLUMN integration_key_hash;

-- Which key delivered each alert.
ALTER TABLE alerts ADD COLUMN api_key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL;
