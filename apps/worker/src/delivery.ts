import { incidentRef, INCIDENT_SEVERITY_LABEL, type IncidentSeverity } from "@irp/shared";
import { publish, type WorkerContext } from "./context";

const VERB: Record<string, string> = {
  triggered: "New incident",
  escalated: "ESCALATED — still unacknowledged",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

// Sends one notification row. Only rows still 'queued' are sent, so a
// redelivered job (BullMQ retry, or the sweeper re-enqueuing it) never
// pages someone twice for the same row.
//
// `isFinalAttempt` lets the caller mark the row failed once BullMQ has used
// up its retries; until then the error is rethrown so BullMQ retries with
// backoff.
export async function deliverNotification(ctx: WorkerContext, notificationId: number, isFinalAttempt = true) {
  const { rows } = await ctx.pool.query(
    `SELECT n.id, n.kind, n.status, n.escalation_level, u.name, u.email,
            i.id AS incident_id, i.organization_id, i.number, i.title, i.severity, s.name AS service_name
     FROM notifications n
     JOIN users u ON u.id = n.user_id
     JOIN incidents i ON i.id = n.incident_id
     LEFT JOIN services s ON s.id = i.service_id
     WHERE n.id = $1`,
    [notificationId]
  );
  const n = rows[0];
  if (!n || n.status !== "queued") return "skipped" as const;

  const text =
    `[${INCIDENT_SEVERITY_LABEL[n.severity as IncidentSeverity]}] ${VERB[n.kind]}: ${incidentRef(n.number)} ` +
    `${n.title}${n.service_name ? ` (${n.service_name})` : ""}`;

  try {
    await ctx.sender({ to: { name: n.name, email: n.email }, text });
  } catch (err) {
    await ctx.pool.query(
      `UPDATE notifications SET attempts = attempts + 1, last_error = $2,
              status = CASE WHEN $3 THEN 'failed' ELSE status END
       WHERE id = $1`,
      [notificationId, (err as Error).message, isFinalAttempt]
    );
    if (isFinalAttempt) await publish(ctx, n.organization_id, { type: "incident.updated", incidentId: n.incident_id, number: n.number });
    throw err;
  }

  await ctx.pool.query(
    `UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL
     WHERE id = $1 AND status = 'queued'`,
    [notificationId]
  );
  await publish(ctx, n.organization_id, { type: "incident.updated", incidentId: n.incident_id, number: n.number });
  return "sent" as const;
}
