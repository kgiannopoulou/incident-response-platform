import { aiDraftJobOptions, deliverJobOptions, webhookJobOptions } from "@irp/shared";
import type { WorkerContext } from "./context";
import { handleAckTimeout } from "./ack-timeout";
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

  // Acknowledgement deadlines that passed without their delayed job running.
  const { rows: lateAcks } = await ctx.pool.query<{ id: number }>(
    `SELECT id FROM incidents WHERE ack_deadline_at IS NOT NULL AND ack_deadline_at <= now()
     ORDER BY ack_deadline_at LIMIT 100`
  );
  let ackTimeouts = 0;
  for (const { id } of lateAcks) {
    try {
      if ((await handleAckTimeout(ctx, id)).timedOut) ackTimeouts++;
    } catch (err) {
      console.error(`Sweep: acknowledgement timeout for incident ${id} failed`, err);
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
  // Same for webhook deliveries (outbox rows written with the change).
  const { rows: stuckHooks } = await ctx.pool.query<{ id: number }>(
    `SELECT id FROM webhook_deliveries WHERE status = 'queued' AND created_at < now() - interval '30 seconds'
     ORDER BY id LIMIT 200`
  );
  for (const { id } of stuckHooks) {
    await ctx.webhooksQueue.add("deliver-webhook", { deliveryId: id }, webhookJobOptions(id));
  }
  // AI drafts: re-enqueue queued ones whose job was lost; give up on ones a
  // worker started long ago and never finished (it died mid-request).
  const { rows: stuckDrafts } = await ctx.pool.query<{ id: number }>(
    `SELECT id FROM postmortem_ai_drafts WHERE status = 'queued' AND created_at < now() - interval '60 seconds'
     ORDER BY id LIMIT 50`
  );
  for (const { id } of stuckDrafts) {
    await ctx.aiDraftsQueue.add("draft-postmortem", { draftId: id }, aiDraftJobOptions(id));
  }
  await ctx.pool.query(
    `UPDATE postmortem_ai_drafts SET status = 'failed', error = 'The worker stopped while generating this draft; generate it again',
            completed_at = now()
     WHERE status = 'generating' AND started_at < now() - interval '10 minutes'`
  );
  return { escalated, ackTimeouts, requeued: stuck.length + stuckHooks.length + stuckDrafts.length };
}
