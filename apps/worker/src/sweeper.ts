import { deliverJobOptions } from "@irp/shared";
import type { WorkerContext } from "./context";
import { escalateIncident } from "./escalation";

// Safety net that makes Postgres — not Redis — the source of truth.
// Runs every few seconds and recovers anything a lost queue job would
// otherwise drop: the API committing but crashing before it enqueued, Redis
// being flushed, a delayed job vanishing. Both actions are idempotent, so
// overlapping with the normal job flow is harmless.
export async function sweep(ctx: WorkerContext) {
  // Escalations that are due (or overdue). escalateIncident row-locks and
  // re-checks each one, so parallel worker replicas can't double-page.
  const { rows: due } = await ctx.pool.query<{ id: number }>(
    `SELECT id FROM incidents
     WHERE next_escalation_at IS NOT NULL AND next_escalation_at <= now()
     ORDER BY next_escalation_at LIMIT 100`
  );
  let escalated = 0;
  for (const { id } of due) {
    try {
      if ((await escalateIncident(ctx, id)).paged) escalated++;
    } catch (err) {
      console.error(`Sweep: escalating incident ${id} failed`, err);
    }
  }

  // Notifications still queued well after creation: (re-)enqueue. The job
  // id dedups against a job that is in fact still waiting in the queue.
  const { rows: stuck } = await ctx.pool.query<{ id: number }>(
    `SELECT id FROM notifications WHERE status = 'queued' AND created_at < now() - interval '30 seconds'
     ORDER BY id LIMIT 200`
  );
  for (const { id } of stuck) {
    await ctx.notificationsQueue.add(
      "deliver",
      { notificationId: id },
      deliverJobOptions(id)
    );
  }
  return { escalated, requeued: stuck.length };
}
