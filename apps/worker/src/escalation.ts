import { pageNextEscalationStep, withTransaction } from "@irp/database";
import { deliverJobOptions, escalateJobOptions, shouldEscalate, type IncidentStatus } from "@irp/shared";
import { publish, type WorkerContext } from "./context";

// Pages the next step of an incident's escalation policy, if it's due.
//
// Idempotent and safe to call any number of times, from the queue job or
// from the sweeper: it works off the row-locked incident's
// escalation_level / next_escalation_at, so a duplicated or late job either
// does the next step exactly once or nothing at all. Acknowledging (or
// resolving) clears next_escalation_at, which is what stops escalation.
export async function escalateIncident(ctx: WorkerContext, incidentId: number) {
  const outcome = await withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query<{
      id: number;
      organization_id: number;
      number: number;
      status: IncidentStatus;
      escalation_level: number;
      triggered_at: Date;
      next_escalation_at: Date | null;
      policy_id: number | null;
      due: boolean;
    }>(
      `SELECT i.id, i.organization_id, i.number, i.status, i.escalation_level, i.triggered_at, i.next_escalation_at,
              s.escalation_policy_id AS policy_id, (i.next_escalation_at <= now()) AS due
       FROM incidents i LEFT JOIN services s ON s.id = i.service_id
       WHERE i.id = $1 FOR UPDATE OF i`,
      [incidentId]
    );
    const incident = rows[0];
    if (!incident || !incident.next_escalation_at) return null;
    if (!shouldEscalate(incident.status) || !incident.policy_id) {
      await db.query(`UPDATE incidents SET next_escalation_at = NULL WHERE id = $1`, [incidentId]);
      return null;
    }
    if (!incident.due) return { incident, notificationIds: [], nextAt: incident.next_escalation_at, paged: false };

    const paged = await pageNextEscalationStep(db, incident, incident.policy_id);
    if (!paged) {
      await db.query(`UPDATE incidents SET next_escalation_at = NULL WHERE id = $1`, [incidentId]);
      await db.query(
        `INSERT INTO timeline_events (incident_id, event_type, message) VALUES ($1, 'INCIDENT_ESCALATED', $2)`,
        [incidentId, "Escalation policy exhausted — still unacknowledged"]
      );
      return { incident, notificationIds: [], nextAt: null, paged: true };
    }

    const isFirst = incident.escalation_level === 0;
    const names = paged.recipients.map((t) => t.name).join(", ") || "nobody (empty step)";
    await db.query(`INSERT INTO timeline_events (incident_id, event_type, message, metadata) VALUES ($1, $2, $3, $4)`, [
      incidentId,
      isFirst ? "NOTIFICATION_SENT" : "INCIDENT_ESCALATED",
      isFirst
        ? `Paged ${names} (escalation level ${paged.level})`
        : `Not acknowledged — escalated to level ${paged.level}: paged ${names}`,
      JSON.stringify({ level: paged.level, userIds: paged.recipients.map((t) => t.id) }),
    ]);
    await db.query(
      `INSERT INTO audit_log (organization_id, action, entity_type, entity_id, details)
       VALUES ($1, 'incident.escalate', 'incident', $2, $3)`,
      [incident.organization_id, incidentId, JSON.stringify({ level: paged.level, notified: paged.recipients.length })]
    );
    return { incident, notificationIds: paged.notificationIds, nextAt: paged.nextEscalationAt, paged: true };
  });

  if (!outcome) return { paged: false, notifications: 0 };

  // After COMMIT: deliver pages, schedule the next step, tell browsers.
  for (const id of outcome.notificationIds) {
    await ctx.notificationsQueue.add("deliver", { notificationId: id }, deliverJobOptions(id));
  }
  if (outcome.nextAt) {
    await ctx.escalationsQueue.add("escalate", { incidentId }, escalateJobOptions(Math.max(0, outcome.nextAt.getTime() - Date.now())));
  }
  if (outcome.paged) {
    const { organization_id, number } = outcome.incident;
    await publish(ctx, organization_id, { type: "timeline.added", incidentId });
    await publish(ctx, organization_id, { type: "incident.updated", incidentId, number });
  }
  return { paged: outcome.paged, notifications: outcome.notificationIds.length };
}
