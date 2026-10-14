import { renderPageEmail, type IncidentSeverity, type PageKind } from "@irp/shared";
import { publish, type WorkerContext } from "./context";

// Sends one page (a notification row) by email. Only rows still 'queued'
// are sent, so a redelivered job (BullMQ retry, or the sweeper re-enqueuing
// it) never pages someone twice for the same row.
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

  const message = renderPageEmail({
    kind: n.kind as PageKind,
    recipientName: n.name,
    incident: { number: n.number, title: n.title, severity: n.severity as IncidentSeverity, serviceName: n.service_name },
    escalationLevel: n.escalation_level,
    webOrigin: ctx.webOrigin,
  });

  let messageId: string | null;
  try {
    ({ messageId } = await ctx.email({ to: { name: n.name, email: n.email }, ...message }));
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
    `UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL,
            provider_message_id = $2
     WHERE id = $1 AND status = 'queued'`,
    [notificationId, messageId]
  );
  await publish(ctx, n.organization_id, { type: "incident.updated", incidentId: n.incident_id, number: n.number });
  return "sent" as const;
}
