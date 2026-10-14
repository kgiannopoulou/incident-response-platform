-- Phase 5: turning alerts into incidents (correlation).
--
-- Alerts that share a deduplication key are grouped into the one open
-- incident for that key (see incidents_open_dedup_idx in 0001). Two extra
-- columns make the grouped incident self-describing:
--
--   last_alert_at           when the problem was last reported — "still
--                           firing?" at a glance, without scanning alerts
--   highest_alert_severity  the most severe alert grouped so far. The
--                           incident severity is raised only when an alert
--                           is *more* severe than this, so a responder who
--                           deliberately downgrades an incident isn't
--                           overruled by the next repeat of the same alert.

ALTER TABLE incidents ADD COLUMN last_alert_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN highest_alert_severity TEXT
  CHECK (highest_alert_severity IN ('critical', 'high', 'warning', 'info'));

UPDATE incidents i SET
  last_alert_at = agg.last_at,
  highest_alert_severity = agg.top
FROM (
  SELECT ia.incident_id,
         max(a.received_at) AS last_at,
         (array_agg(a.severity ORDER BY CASE a.severity
            WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END DESC))[1] AS top
  FROM incident_alerts ia JOIN alerts a ON a.id = ia.alert_id
  GROUP BY ia.incident_id
) agg
WHERE agg.incident_id = i.id;
