import type { Job, Worker } from "bullmq";
import type { DeadLetterJob, WorkerHeartbeat, WorkQueue } from "@irp/shared";
import type { WorkerContext } from "./context";

// True when this failure used up the job's last attempt: BullMQ won't retry
// it again, so it's the moment to dead-letter it.
export function isFinalFailure(job: Pick<Job, "attemptsMade" | "opts">) {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

// Which organization a failed job belongs to, so the dead-letter view and
// retries stay tenant-scoped even though the queue itself is shared.
async function organizationOf(ctx: WorkerContext, queue: WorkQueue, data: Record<string, unknown>) {
  const { rows } =
    queue === "notifications"
      ? await ctx.pool.query<{ organization_id: number }>(
          `SELECT i.organization_id FROM notifications n JOIN incidents i ON i.id = n.incident_id WHERE n.id = $1`,
          [data.notificationId]
        )
      : await ctx.pool.query<{ organization_id: number }>(`SELECT organization_id FROM incidents WHERE id = $1`, [
          data.incidentId,
        ]);
  return rows[0]?.organization_id ?? null;
}

// Copies a job that exhausted its retries into the dead-letter queue: the
// original queue, name, data, error and attempts. No worker consumes that
// queue — it's a holding area an admin reviews on the System page, where a
// job can be retried (re-enqueued on its original queue) or discarded.
export async function deadLetter(ctx: WorkerContext, queue: WorkQueue, job: Job, err: Error) {
  const data = job.data as Record<string, unknown>;
  const entry: DeadLetterJob & { organizationId: number | null } = {
    queue,
    name: job.name,
    jobId: job.id ?? null,
    data,
    failedReason: err.message,
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
    organizationId: await organizationOf(ctx, queue, data).catch(() => null),
  };
  await ctx.deadLetterQueue.add(`${queue}:${job.name}`, entry, { removeOnComplete: true });
  return entry;
}

// Wires a worker's failure handling: every failure is logged; one that used
// up the last retry is copied to the dead-letter queue (the job itself is
// removed from its queue by removeOnFail).
export function handleFailures(
  ctx: WorkerContext,
  queue: WorkQueue,
  worker: Worker,
  stats?: Pick<WorkerHeartbeat, "processed" | "failed" | "deadLettered">
) {
  worker.on("completed", () => {
    if (stats) stats.processed++;
  });
  worker.on("failed", async (job: Job | undefined, err) => {
    if (stats) stats.failed++;
    if (!job) return console.error(`[${queue}] job failed: ${err.message}`);
    console.error(`[${queue}] job ${job.id} attempt ${job.attemptsMade}/${job.opts.attempts ?? 1} failed: ${err.message}`);
    if (!isFinalFailure(job)) return;
    try {
      await deadLetter(ctx, queue, job, err);
      if (stats) stats.deadLettered++;
      console.error(`[${queue}] job ${job.id} moved to the dead-letter queue`);
    } catch (dlqErr) {
      console.error(`[${queue}] could not dead-letter job ${job.id}:`, dlqErr);
    }
  });
}
