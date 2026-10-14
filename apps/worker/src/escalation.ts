import { withTransaction } from "@irp/database";
import { deliverJobOptions, shouldEscalate, type IncidentStatus } from "@irp/shared";
import { publish, type WorkerContext } from "./context";

// Pages the next level of an incident's escalation policy, if it's due.
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
      next_escalation_at: Date | null;
      policy_id: number | null;
      due: boolean;
    }>(
      `SELECT i.id, i.organization_id, i.number, i.status, i.escalation_level, i.next_escalation_at,
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

    const { rows: levels } = await db.query<{ level: number; delay_minutes: number }>(
      `SELECT DISTINCT level, delay_minutes FROM escalation_rules WHERE policy_id = $1 AND level > $2 ORDER BY level`,
      [incident.policy_id, incident.escalation_level]
    );
    const current = levels[0];
    if (!current) {
      await db.query(`UPDATE incidents SET next_escalation_at = NULL WHERE id = $1`, [incidentId]);
      await db.query(
        `INSERT INTO timeline_events (incident_id, event_type, message) VALUES ($1, 'INCIDENT_ESCALATED', $2)`,
        [incidentId, "Escalation policy exhausted — still unacknowledged"]
      );
      return { incident, notificationIds: [], nextAt: null, paged: true };
    }

    // Everyone targeted at this level: direct users plus team members.
    const { rows: targets } = await db.query<{ id: number; name: string }>(
      `SELECT DISTINCT u.id, u.name FROM escalation_rules r
       LEFT JOIN team_members tm ON tm.team_id = r.target_team_id
       JOIN users u ON u.id = COALESCE(r.target_user_id, tm.user_id)
       WHERE r.policy_id = $1 AND r.level = $2
       ORDER BY u.name`,
      [incident.policy_id, current.level]
    );

    const isFirst = incident.escalation_level === 0;
    const notificationIds: number[] = [];
    for (const target of targets) {
      // The unique index makes a retried escalation step page nobody twice.
      const { rows: inserted } = await db.query<{ id: number }>(
        `INSERT INTO notifications (incident_id, user_id, kind, escalation_level)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (incident_id, user_id, kind, escalation_level) DO NOTHING RETURNING id`,
        [incidentId, target.id, isFirst ? "triggered" : "escalated", current.level]
      );
      if (inserted[0]) notificationIds.push(inserted[0].id);
    }

    const names = targets.map((t) => t.name).join(", ") || "nobody (empty level)";
    await db.query(`INSERT INTO timeline_events (incident_id, event_type, message, metadata) VALUES ($1, $2, $3, $4)`, [
      incidentId,
      isFirst ? "NOTIFICATION_SENT" : "INCIDENT_ESCALATED",
      isFirst
        ? `Paged ${names} (escalation level ${current.level})`
        : `Not acknowledged — escalated to level ${current.level}: paged ${names}`,
      JSON.stringify({ level: current.level, userIds: targets.map((t) => t.id) }),
    ]);

    const following = levels[1];
    const { rows: updated } = await db.query<{ next_escalation_at: Date | null }>(
      `UPDATE incidents SET escalation_level = $2,
         next_escalation_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END
       WHERE id = $1 RETURNING next_escalation_at`,
      [incidentId, current.level, following ? following.delay_minutes : null]
    );
    await db.query(
      `INSERT INTO audit_log (organization_id, action, entity_type, entity_id, details)
       VALUES ($1, 'incident.escalate', 'incident', $2, $3)`,
      [incident.organization_id, incidentId, JSON.stringify({ level: current.level, notified: targets.length })]
    );
    return { incident, notificationIds, nextAt: updated[0].next_escalation_at, paged: true };
  });

  if (!outcome) return { paged: false, notifications: 0 };

  // After COMMIT: deliver pages, schedule the next level, tell browsers.
  for (const id of outcome.notificationIds) {
    await ctx.notificationsQueue.add(
      "deliver",
      { notificationId: id },
      deliverJobOptions(id)
    );
  }
  if (outcome.nextAt) {
    await ctx.escalationsQueue.add(
      "escalate",
      { incidentId },
      { delay: Math.max(0, outcome.nextAt.getTime() - Date.now()), removeOnComplete: true, removeOnFail: 100 }
    );
  }
  if (outcome.paged) {
    const { organization_id, number } = outcome.incident;
    await publish(ctx, organization_id, { type: "timeline.added", incidentId });
    await publish(ctx, organization_id, { type: "incident.updated", incidentId, number });
  }
  return { paged: outcome.paged, notifications: outcome.notificationIds.length };
}
