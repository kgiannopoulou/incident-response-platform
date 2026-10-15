import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { buildAiContext, type AiPostmortemContext, type IncidentSeverity } from "@irp/shared";

type Db = Pick<PoolClient, "query">;

const seconds = (from: Date, to: Date | null) => (to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000)) : null);

// Everything an AI postmortem draft may be based on, read from the source
// tables (never from the editable postmortem text): the incident, its
// alerts, its responders and its immutable timeline — which includes the
// responders' notes and the resolution.
export async function loadAiPostmortemContext(db: Db, incidentId: number): Promise<AiPostmortemContext | null> {
  const { rows } = await db.query(
    `SELECT i.*, s.name AS service_name FROM incidents i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1`,
    [incidentId]
  );
  const incident = rows[0];
  if (!incident) return null;

  const [{ rows: alerts }, { rows: responders }, { rows: timeline }] = await Promise.all([
    db.query(
      `SELECT a.public_id, a.received_at, a.severity, a.source, a.title, a.description, a.metadata
       FROM alerts a JOIN incident_alerts ia ON ia.alert_id = a.id WHERE ia.incident_id = $1 ORDER BY a.received_at`,
      [incidentId]
    ),
    db.query(
      `SELECT u.name, r.role FROM incident_responders r JOIN users u ON u.id = r.user_id
       WHERE r.incident_id = $1 ORDER BY r.joined_at`,
      [incidentId]
    ),
    db.query(
      `SELECT t.id, t.created_at, t.event_type, t.message, u.name AS actor_name
       FROM timeline_events t LEFT JOIN users u ON u.id = t.actor_id
       WHERE t.incident_id = $1 ORDER BY t.id`,
      [incidentId]
    ),
  ]);

  return buildAiContext({
    incident: {
      number: incident.number,
      title: incident.title,
      severity: incident.severity as IncidentSeverity,
      serviceName: incident.service_name,
      status: incident.status,
      triggeredAt: incident.triggered_at,
      acknowledgedAt: incident.acknowledged_at,
      mitigatedAt: incident.mitigated_at,
      resolvedAt: incident.resolved_at,
    },
    metrics: {
      timeToAcknowledgeSeconds: seconds(incident.triggered_at, incident.acknowledged_at),
      timeToMitigateSeconds: seconds(incident.triggered_at, incident.mitigated_at ?? incident.resolved_at),
      timeToResolveSeconds: seconds(incident.triggered_at, incident.resolved_at),
      escalations: timeline.filter((e) => e.event_type === "INCIDENT_ESCALATED").length,
      ackTimeouts: timeline.filter((e) => e.event_type === "ACK_TIMEOUT").length,
    },
    alerts: alerts.map((a) => ({
      publicId: a.public_id,
      receivedAt: a.received_at,
      severity: a.severity,
      source: a.source,
      title: a.title,
      description: a.description ?? "",
      metadata: a.metadata ?? {},
    })),
    responders: responders.map((r) => ({ name: r.name, role: r.role })),
    timeline: timeline.map((e) => ({ id: e.id, createdAt: e.created_at, type: e.event_type, actorName: e.actor_name, message: e.message })),
  });
}

// Fingerprint of the exact input a draft was generated from, stored with it.
export const aiContextDigest = (context: AiPostmortemContext) =>
  createHash("sha256").update(JSON.stringify(context)).digest("hex");
