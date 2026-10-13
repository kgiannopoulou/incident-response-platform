import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createPool } from "@irp/database";
import { QUEUES, type DeliverNotificationJob, type EscalateIncidentJob } from "@irp/shared";
import { createSender, type WorkerContext } from "./context";
import { deliverNotification } from "./delivery";
import { escalateIncident } from "./escalation";
import { sweep } from "./sweeper";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("Missing required environment variable: REDIS_URL");
const connection = { url: redisUrl };

const ctx: WorkerContext = {
  pool: createPool(),
  redis: new Redis(redisUrl, { maxRetriesPerRequest: null }),
  notificationsQueue: new Queue(QUEUES.notifications, { connection }),
  escalationsQueue: new Queue(QUEUES.escalations, { connection }),
  sender: createSender(process.env.NOTIFY_WEBHOOK_URL || undefined),
};

const notifications = new Worker<DeliverNotificationJob>(
  QUEUES.notifications,
  async (job) => {
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return deliverNotification(ctx, job.data.notificationId, isFinalAttempt);
  },
  { connection, concurrency: 10 }
);

const escalations = new Worker<EscalateIncidentJob>(
  QUEUES.escalations,
  async (job) => escalateIncident(ctx, job.data.incidentId),
  { connection, concurrency: 5 }
);

for (const worker of [notifications, escalations]) {
  worker.on("failed", (job, err) => console.error(`[${worker.name}] job ${job?.id} failed: ${err.message}`));
}

// The recovery sweep runs on a plain timer, not as a BullMQ repeatable job:
// it exists to recover from losing Redis state, so it must not live in
// Redis itself. Every replica sweeps; each step is idempotent.
let sweeping = false;
const sweepTimer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const result = await sweep(ctx);
    if (result.escalated || result.requeued) console.log(`[sweep] escalated ${result.escalated}, requeued ${result.requeued}`);
  } catch (err) {
    console.error("[sweep] failed:", err);
  } finally {
    sweeping = false;
  }
}, 10_000);
console.log("Worker started: notifications + escalations queues, sweeping every 10s.");

async function shutdown() {
  console.log("Shutting down worker...");
  clearInterval(sweepTimer);
  await Promise.all([notifications.close(), escalations.close()]);
  await Promise.all([ctx.notificationsQueue.close(), ctx.escalationsQueue.close()]);
  await ctx.redis.quit();
  await ctx.pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
