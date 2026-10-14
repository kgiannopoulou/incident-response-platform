import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createPool } from "@irp/database";
import { QUEUES, type DeliverNotificationJob, type DeliverWebhookJob, type EscalateIncidentJob } from "@irp/shared";
import { createEmailSender, type WorkerContext } from "./context";
import { handleFailures } from "./dead-letter";
import { deliverNotification } from "./delivery";
import { escalateIncident } from "./escalation";
import { Heartbeat } from "./heartbeat";
import { sweep } from "./sweeper";
import { deliverWebhook } from "./webhooks";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("Missing required environment variable: REDIS_URL");
const connection = { url: redisUrl };

const ctx: WorkerContext = {
  pool: createPool(),
  redis: new Redis(redisUrl, { maxRetriesPerRequest: null }),
  notificationsQueue: new Queue(QUEUES.notifications, { connection }),
  escalationsQueue: new Queue(QUEUES.escalations, { connection }),
  webhooksQueue: new Queue(QUEUES.webhooks, { connection }),
  deadLetterQueue: new Queue(QUEUES.deadLetter, { connection }),
  email: createEmailSender(process.env.SMTP_URL || undefined, process.env.EMAIL_FROM ?? "Fireline <pager@fireline.local>"),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  blockPrivateWebhookTargets: process.env.WEBHOOK_BLOCK_PRIVATE_NETWORKS === "true",
};
const heartbeat = new Heartbeat(ctx.redis);

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

const webhooks = new Worker<DeliverWebhookJob>(
  QUEUES.webhooks,
  async (job) => deliverWebhook(ctx, job.data.deliveryId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
  { connection, concurrency: 10 }
);

handleFailures(ctx, QUEUES.notifications, notifications, heartbeat.stats);
handleFailures(ctx, QUEUES.escalations, escalations, heartbeat.stats);
handleFailures(ctx, QUEUES.webhooks, webhooks, heartbeat.stats);

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
heartbeat.start();
console.log(`Worker ${heartbeat.stats.id} started: notifications, escalations, webhooks queues; sweeping every 10s.`);

// Graceful shutdown: let in-flight jobs finish (Worker.close waits for
// them), then release connections. A job interrupted by a hard kill is
// re-delivered by BullMQ's stalled-job check.
async function shutdown() {
  console.log("Shutting down worker...");
  clearInterval(sweepTimer);
  await Promise.all([notifications.close(), escalations.close(), webhooks.close()]);
  await heartbeat.stop();
  await Promise.all([ctx.notificationsQueue.close(), ctx.escalationsQueue.close(), ctx.webhooksQueue.close(), ctx.deadLetterQueue.close()]);
  await ctx.redis.quit();
  await ctx.pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
