import { pageNextEscalationStep, queueWebhookEvent, withTransaction } from "@irp/database";
import {
  deliverJobOptions,
  escalateJobOptions,
  INCIDENT_SEVERITY_LABEL,
  webhookJobOptions,
  type IncidentSeverity,
  type IncidentStatus,
} from "@irp/shared";
import { publish, type WorkerContext } from "./context";

// Fires when a high-urgency incident's acknowledgement deadline passes.
//
//   acknowledged in time? ── yes ──► nothing (the API cleared the deadline and removed this job)
//          │ no
//          ▼
//   page the next escalation step now, without waiting for its delay
//
// Runs from the delayed "ack-timeout" job or from the sweeper; idempotent:
// it acts only on a row-locked incident that is still triggered with a
// deadline in the past, and clears the deadline as it acts, so a duplicate
// or late job finds nothing to do.
export async function handleAckTimeout(ctx: WorkerContext, incidentId: number) {
  const outcome = await withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query<{
      id: number;
      organization_id: number;
      number: number;
      severity: IncidentSeverity;
      status: IncidentStatus;
      escalation_level: number;
      triggered_at: Date;
      ack_deadline_at: Date | null;
      policy_id: number | null;
      timeout_minutes: number | null;
      due: boolean;
    }>(
      `SELECT i.id, i.organization_id, i.number, i.severity, i.status, i.escalation_level, i.triggered_at,
              i.ack_deadline_at, s.escalation_policy_id AS policy_id, ep.ack_timeout_minutes AS timeout_minutes,
              (i.ack_deadline_at <= now()) AS due
       FROM incidents i
       LEFT JOIN services s ON s.id = i.service_id
       LEFT JOIN escalation_policies ep ON ep.id = s.escalation_policy_id
       WHERE i.id = $1 FOR UPDATE OF i`,
      [incidentId]
    );
    const incident = rows[0];
    if (!incident?.ack_deadline_at) return null;
    if (incident.status !== "triggered") {
      await db.query(`UPDATE incidents SET ack_deadline_at = NULL WHERE id = $1`, [incidentId]);
      return null;
    }
    if (!incident.due) return null; // rescheduled later, e.g. after a severity change

    await db.query(`UPDATE incidents SET ack_deadline_at = NULL, ack_timed_out_at = now() WHERE id = $1`, [incidentId]);
    const waited = Math.round((Date.now() - incident.triggered_at.getTime()) / 60_000);
    await db.query(
      `INSERT INTO timeline_events (incident_id, event_type, message, metadata) VALUES ($1, 'ACK_TIMEOUT', $2, $3)`,
      [
        incidentId,
        `Not acknowledged within ${incident.timeout_minutes ?? waited} min (${INCIDENT_SEVERITY_LABEL[incident.severity]}) — acknowledgement timeout expired`,
        JSON.stringify({ timeoutMinutes: incident.timeout_minutes, severity: incident.severity }),
      ]
    );

    const paged = incident.policy_id
      ? await pageNextEscalationStep(db, incident, incident.policy_id)
      : null;
    if (paged) {
      const names = paged.recipients.map((r) => r.name).join(", ") || "nobody (empty step)";
      await db.query(
        `INSERT INTO timeline_events (incident_id, event_type, message, metadata) VALUES ($1, 'INCIDENT_ESCALATED', $2, $3)`,
        [
          incidentId,
          `Acknowledgement timeout — escalated to level ${paged.level} early: paged ${names}`,
          JSON.stringify({ level: paged.level, userIds: paged.recipients.map((r) => r.id), reason: "ack_timeout" }),
        ]
      );
    } else {
      await db.query(
        `INSERT INTO timeline_events (incident_id, event_type, message) VALUES ($1, 'INCIDENT_ESCALATED', $2)`,
        [incidentId, "Acknowledgement timeout — every escalation step has already been paged"]
      );
    }
    await db.query(
      `INSERT INTO audit_log (organization_id, action, entity_type, entity_id, details)
       VALUES ($1, 'incident.ack_timeout', 'incident', $2, $3)`,
      [incident.organization_id, incidentId, JSON.stringify({ level: paged?.level ?? null, notified: paged?.recipients.length ?? 0 })]
    );
    const webhookIds = paged ? await queueWebhookEvent(db, "incident.escalated", incidentId) : [];
    return { incident, paged, webhookIds };
  });

  if (!outcome) return { timedOut: false, notifications: 0 };

  // After COMMIT: deliver pages and webhooks, keep the step schedule going.
  const { incident, paged, webhookIds } = outcome;
  for (const id of paged?.notificationIds ?? []) {
    await ctx.notificationsQueue.add("deliver", { notificationId: id }, deliverJobOptions(id));
  }
  for (const id of webhookIds) {
    await ctx.webhooksQueue.add("deliver-webhook", { deliveryId: id }, webhookJobOptions(id));
  }
  if (paged?.nextEscalationAt) {
    await ctx.escalationsQueue.add("escalate", { incidentId }, escalateJobOptions(Math.max(0, paged.nextEscalationAt.getTime() - Date.now())));
  }
  await publish(ctx, incident.organization_id, { type: "timeline.added", incidentId });
  await publish(ctx, incident.organization_id, { type: "incident.updated", incidentId, number: incident.number });
  return { timedOut: true, notifications: paged?.notificationIds.length ?? 0 };
}
