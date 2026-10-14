import type { PoolClient } from "@irp/database";
import {
  ALERT_SEVERITY_RANK,
  INCIDENT_SEVERITY_RANK,
  SEVERITY_FROM_ALERT,
  type AlertSeverity,
} from "@irp/shared";
import type { Effects } from "../lib/effects";
import { addTimeline, changeSeverity, type IncidentRow } from "./incidents";

// Event correlation: not every alert deserves its own incident.
//
//   10:31 checkout-api ERROR ┐
//   10:32 checkout-api ERROR │   one incident, INC-142,
//   10:32 checkout-api ERROR ├─► "Alerts: 4", paged once
//   10:33 checkout-api ERROR ┘
//
// Alerts are correlated by (service, deduplication key). While an incident
// for that key is open, every repeat is attached to it; once it's resolved,
// the next alert starts a new incident.
//
//   const existing = await findOpenIncident(db, serviceId, dedupKey);
//   existing ? await groupAlert(db, fx, existing, alert)
//            : await createIncident(...)

export type CorrelatedAlert = {
  id: number;
  title: string;
  source: string;
  severity: AlertSeverity;
  received_at: Date;
};

// Row-locks the open incident for the key, so concurrent alerts for the same
// problem queue up behind each other instead of double-counting.
export async function findOpenIncident(db: PoolClient, serviceId: number, dedupKey: string) {
  const { rows } = await db.query<IncidentRow>(
    `SELECT * FROM incidents WHERE service_id = $1 AND dedup_key = $2 AND status <> 'resolved' FOR UPDATE`,
    [serviceId, dedupKey]
  );
  return rows[0] ?? null;
}

// Links an alert to an incident and updates the incident's counters. The
// first alert (the one that opened the incident) is already covered by the
// INCIDENT_CREATED timeline event; repeats each get an ALERT_ATTACHED one.
export async function attachAlert(
  db: PoolClient,
  fx: Effects,
  incident: IncidentRow,
  alert: CorrelatedAlert,
  isFirst: boolean
) {
  const { rowCount } = await db.query(
    `INSERT INTO incident_alerts (incident_id, alert_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [incident.id, alert.id]
  );
  if (!rowCount) return incident; // already attached: replays don't inflate the count

  const { rows } = await db.query<IncidentRow>(
    `UPDATE incidents SET
       alert_count = alert_count + 1,
       last_alert_at = GREATEST(last_alert_at, $2),
       highest_alert_severity = CASE
         WHEN highest_alert_severity IS NULL
           OR ${severityRankSql("$3")} > ${severityRankSql("highest_alert_severity")} THEN $3
         ELSE highest_alert_severity END
     WHERE id = $1 RETURNING *`,
    [incident.id, alert.received_at, alert.severity]
  );
  const updated = rows[0];

  if (!isFirst) {
    await addTimeline(
      db,
      fx,
      incident,
      "ALERT_ATTACHED",
      `Alert grouped: "${alert.title}" from ${alert.source}`,
      null,
      { alertId: alert.id, severity: alert.severity, alertCount: updated.alert_count }
    );
  }
  fx.publish(incident.organization_id, {
    type: "incident.updated",
    incidentId: incident.id,
    number: incident.number,
    status: updated.status,
    severity: updated.severity,
  });
  return updated;
}

const severityRankSql = (expr: string) =>
  `(CASE ${expr} WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END)`;

// Attaches a repeat alert to the open incident. If the alert is more severe
// than anything grouped so far *and* than the incident itself — the problem
// got worse, e.g. "HIGH: latency" followed by "CRITICAL: errors" under the
// same key — the incident is raised to match. Severity is never lowered
// automatically, and repeats at a severity already seen don't undo a
// responder's deliberate downgrade.
export async function groupAlert(db: PoolClient, fx: Effects, incident: IncidentRow, alert: CorrelatedAlert) {
  const previousPeak = incident.highest_alert_severity;
  let updated = await attachAlert(db, fx, incident, alert, false);

  const worseThanSeen = !previousPeak || ALERT_SEVERITY_RANK[alert.severity] > ALERT_SEVERITY_RANK[previousPeak];
  const implied = SEVERITY_FROM_ALERT[alert.severity];
  if (worseThanSeen && INCIDENT_SEVERITY_RANK[implied] > INCIDENT_SEVERITY_RANK[updated.severity]) {
    updated = await changeSeverity(db, fx, updated, implied, null, `${alert.severity.toUpperCase()} alert grouped`);
  }
  return updated;
}
