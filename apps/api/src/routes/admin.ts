import { Router } from "express";
import type { Job } from "bullmq";
import {
  deliverJobOptions,
  escalateJobOptions,
  QUEUES,
  webhookJobOptions,
  WORKER_HEARTBEAT_PREFIX,
  type DeadLetterJob,
  type WorkerHeartbeat,
} from "@irp/shared";
import type { Deps } from "../deps";
import { audit } from "../lib/audit";
import { HttpError, notFound } from "../lib/http";

// Operations view of the background machinery (admins only):
//
//   GET    /admin/queues                 job counts per queue + live workers
//   GET    /admin/dead-letter            jobs that exhausted their retries
//   POST   /admin/dead-letter/:id/retry  put one back on its original queue
//   DELETE /admin/dead-letter/:id        discard it
//
// The queues are shared infrastructure, so counts are platform-wide; dead
// letters carry their organization and are only listed / retried for it.

type DeadLetter = DeadLetterJob & { organizationId: number | null };

export async function liveWorkers(deps: Pick<Deps, "redis">) {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await deps.redis.scan(cursor, "MATCH", `${WORKER_HEARTBEAT_PREFIX}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (!keys.length) return [];
  const values = await deps.redis.mget(keys);
  return values.filter((v): v is string => v !== null).map((v) => JSON.parse(v) as WorkerHeartbeat);
}

export function adminRouter(deps: Deps) {
  const router = Router();

  async function ownDeadLetter(id: string, organizationId: number) {
    const job = (await deps.queues.deadLetter.getJob(id)) as Job<DeadLetter> | undefined;
    if (!job || job.data.organizationId !== organizationId) throw notFound("Dead-letter job");
    return job;
  }

  router.get("/queues", async (_req, res) => {
    const states = ["waiting", "active", "delayed", "failed", "completed", "paused"] as const;
    const queues = await Promise.all(
      [deps.queues.notifications, deps.queues.escalations, deps.queues.webhooks, deps.queues.deadLetter].map(async (q) => ({
        name: q.name,
        counts: await q.getJobCounts(...states),
      }))
    );
    res.json({ queues, workers: await liveWorkers(deps) });
  });

  router.get("/dead-letter", async (req, res) => {
    const jobs = (await deps.queues.deadLetter.getJobs(["waiting", "paused"], 0, 499)) as Job<DeadLetter>[];
    const entries = jobs
      .filter((j) => j.data.organizationId === req.user!.organizationId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 100)
      .map((j) => ({ id: j.id, ...j.data }));
    res.json({ entries });
  });

  // Retrying a page resets its notification row to 'queued' first: the row,
  // not the job, is what delivery checks, so a 'failed' row would be skipped.
  router.post("/dead-letter/:id/retry", async (req, res) => {
    const orgId = req.user!.organizationId;
    const job = await ownDeadLetter(req.params.id, orgId);
    const { queue, data } = job.data;

    if (queue === QUEUES.notifications) {
      const notificationId = Number(data.notificationId);
      const { rowCount } = await deps.pool.query(
        `UPDATE notifications n SET status = 'queued', attempts = 0, last_error = NULL
         FROM incidents i WHERE i.id = n.incident_id AND n.id = $1 AND i.organization_id = $2 AND n.status = 'failed'`,
        [notificationId, orgId]
      );
      if (!rowCount) throw new HttpError(409, "That notification is no longer failed");
      await deps.queues.notifications.add("deliver", { notificationId }, deliverJobOptions(notificationId));
    } else if (queue === QUEUES.webhooks) {
      const deliveryId = Number(data.deliveryId);
      const { rowCount } = await deps.pool.query(
        `UPDATE webhook_deliveries SET status = 'queued', attempts = 0, last_error = NULL
         WHERE id = $1 AND organization_id = $2 AND status = 'failed'`,
        [deliveryId, orgId]
      );
      if (!rowCount) throw new HttpError(409, "That webhook delivery is no longer failed");
      await deps.queues.webhooks.add("deliver-webhook", { deliveryId }, webhookJobOptions(deliveryId));
    } else {
      await deps.queues.escalations.add(job.data.name, { incidentId: Number(data.incidentId) }, escalateJobOptions());
    }
    await job.remove();
    await audit(deps.pool, {
      organizationId: orgId,
      actorUserId: req.user!.id,
      action: "dead_letter.retry",
      entityType: "job",
      details: { queue, name: job.data.name, jobId: job.data.jobId, failedReason: job.data.failedReason },
    });
    res.json({ retried: true, queue });
  });

  router.delete("/dead-letter/:id", async (req, res) => {
    const orgId = req.user!.organizationId;
    const job = await ownDeadLetter(req.params.id, orgId);
    await job.remove();
    await audit(deps.pool, {
      organizationId: orgId,
      actorUserId: req.user!.id,
      action: "dead_letter.discard",
      entityType: "job",
      details: { queue: job.data.queue, name: job.data.name, jobId: job.data.jobId },
    });
    res.status(204).end();
  });

  return router;
}
