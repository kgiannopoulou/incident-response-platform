-- Phase 21: failure handling.
--
-- 1. Idempotent ingestion. A monitoring tool (or the SDK) that retries after
--    a timeout can't know whether the first request was committed. With an
--    `Idempotency-Key` header, the first request stores its response here in
--    the same transaction as the alert; a repeat with the same key replays
--    that response instead of recording the alert again. Keys are scoped to
--    the service (the API key decides the service), kept for 24 hours.

CREATE TABLE alert_idempotency_keys (
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  key           TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  -- sha256 of the request body: the same key with a different payload is a
  -- client bug and is refused (422) rather than silently replayed.
  request_hash  TEXT NOT NULL,
  status_code   INTEGER,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, key)
);
CREATE INDEX alert_idempotency_keys_created ON alert_idempotency_keys (created_at);

-- 2. Delivery leases. A worker claims a page / webhook delivery before
--    calling the outside world by setting delivering_until; a second worker
--    (BullMQ's stalled-job redelivery, the sweeper, another replica) skips a
--    row whose lease is still running instead of sending it in parallel. If
--    the worker dies mid-delivery the lease simply expires and the sweeper
--    re-drives the row: at-least-once, with a stable Message-ID /
--    Fireline-Delivery id that lets receivers drop the rare duplicate.

ALTER TABLE notifications ADD COLUMN delivering_until TIMESTAMPTZ;
ALTER TABLE webhook_deliveries ADD COLUMN delivering_until TIMESTAMPTZ;

COMMENT ON COLUMN notifications.delivering_until IS
  'Lease: a worker is sending this page until then. NULL = nobody is. Expired = the worker died; the sweeper re-drives it.';
COMMENT ON COLUMN webhook_deliveries.delivering_until IS
  'Lease: a worker is POSTing this delivery until then (see notifications.delivering_until).';
