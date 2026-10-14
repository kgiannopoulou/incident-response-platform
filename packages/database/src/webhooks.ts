import type pg from "pg";
import { buildWebhookPayload, ulid, type IncidentSeverity, type IncidentStatus, type WebhookEvent } from "@irp/shared";

// Webhook fan-out, shared by the API and the worker. Called inside the
// transaction that made the change: it writes one webhook_deliveries row
// (an outbox entry) per enabled endpoint subscribed to the event and
// returns their ids; the caller enqueues delivery jobs after COMMIT. A lost
// job only delays a delivery — the worker's sweeper re-drives queued rows.

const webOrigin = () => process.env.WEB_ORIGIN ?? "http://localhost:3000";

export async function queueWebhookEvent(
  db: pg.PoolClient,
  event: WebhookEvent,
  incidentId: number,
  { actor = null }: { actor?: string | null } = {}
): Promise<number[]> {
  const { rows } = await db.query<{
    organization_id: number;
    number: number;
    title: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    escalation_level: number;
    triggered_at: Date;
    acknowledged_at: Date | null;
    resolved_at: Date | null;
    service_name: string | null;
    service_slug: string | null;
  }>(
    `SELECT i.organization_id, i.number, i.title, i.severity, i.status, i.escalation_level,
            i.triggered_at, i.acknowledged_at, i.resolved_at, s.name AS service_name, s.slug AS service_slug
     FROM incidents i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1`,
    [incidentId]
  );
  const incident = rows[0];
  if (!incident) return [];

  const payload = buildWebhookPayload(
    event,
    `evt_${ulid()}`,
    {
      number: incident.number,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      serviceName: incident.service_name,
      serviceSlug: incident.service_slug,
      escalationLevel: incident.escalation_level,
      triggeredAt: incident.triggered_at,
      acknowledgedAt: incident.acknowledged_at,
      resolvedAt: incident.resolved_at,
    },
    { webOrigin: webOrigin(), actor }
  );

  const { rows: deliveries } = await db.query<{ id: number }>(
    `INSERT INTO webhook_deliveries (endpoint_id, organization_id, incident_id, event, payload)
     SELECT e.id, e.organization_id, $2, $3, $4 FROM webhook_endpoints e
     WHERE e.organization_id = $1 AND e.enabled AND $3 = ANY(e.events)
     ORDER BY e.id
     RETURNING id`,
    [incident.organization_id, incidentId, event, JSON.stringify(payload)]
  );
  return deliveries.map((d) => d.id);
}
