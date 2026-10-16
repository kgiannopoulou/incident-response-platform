import { renderPageEmail, type IncidentSeverity, type PageKind } from "@irp/shared";
import { publish, type WorkerContext } from "./context";

// Sends one page (a notification row) by email. Only rows still 'queued'
// are sent, so a redelivered job (BullMQ retry, or the sweeper re-enqueuing
// it) never pages someone twice for the same row.
//
// Before calling SMTP the worker takes a short lease on the row
// (delivering_until). A second worker that picks up the same row while the
// lease runs (BullMQ re-delivering a job it thinks stalled, the sweeper,
// another replica) skips it instead of sending in parallel. If this worker
// crashes after the email left but before the row says 'sent', the lease
// expires and the sweeper re-drives it: at-least-once, never silently
// dropped. The Message-ID is derived from the row id, so that rare
// duplicate carries the same id as the original and mail systems can
// collapse it.
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
  if (!(await claimLease(ctx, "notifications", notificationId))) return "skipped" as const;

  const message = renderPageEmail({
    kind: n.kind as PageKind,
    recipientName: n.name,
    incident: { number: n.number, title: n.title, severity: n.severity as IncidentSeverity, serviceName: n.service_name },
    escalationLevel: n.escalation_level,
    webOrigin: ctx.webOrigin,
  });

  let messageId: string | null;
  try {
    ({ messageId } = await ctx.email({ to: { name: n.name, email: n.email }, ...message, messageId: pageMessageId(notificationId) }));
  } catch (err) {
    await ctx.pool.query(
      `UPDATE notifications SET attempts = attempts + 1, last_error = $2, delivering_until = NULL,
              status = CASE WHEN $3 THEN 'failed' ELSE status END
       WHERE id = $1`,
      [notificationId, (err as Error).message, isFinalAttempt]
    );
    if (isFinalAttempt) await publish(ctx, n.organization_id, { type: "incident.updated", incidentId: n.incident_id, number: n.number });
    throw err;
  }

  await ctx.pool.query(
    `UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL,
            delivering_until = NULL, provider_message_id = $2
     WHERE id = $1 AND status = 'queued'`,
    [notificationId, messageId]
  );
  await publish(ctx, n.organization_id, { type: "incident.updated", incidentId: n.incident_id, number: n.number });
  return "sent" as const;
}

// Longer than any single attempt can take (SMTP / webhook timeouts are
// 10 s), short enough that a crashed worker's row is re-driven quickly.
export const DELIVERY_LEASE_SECONDS = 60;

// Atomically marks a still-queued row as "being delivered by me". False when
// another worker holds a live lease (or the row is no longer queued).
export async function claimLease(
  ctx: Pick<WorkerContext, "pool">,
  table: "notifications" | "webhook_deliveries",
  id: number,
  seconds = DELIVERY_LEASE_SECONDS
) {
  const { rowCount } = await ctx.pool.query(
    `UPDATE ${table} SET delivering_until = now() + make_interval(secs => $2)
     WHERE id = $1 AND status = 'queued' AND (delivering_until IS NULL OR delivering_until < now())`,
    [id, seconds]
  );
  return rowCount === 1;
}

// Stable per page, so a re-sent page is recognisably the same message.
export const pageMessageId = (notificationId: number) => `<page-${notificationId}@fireline.local>`;
