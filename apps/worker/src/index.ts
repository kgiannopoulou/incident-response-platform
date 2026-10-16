import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createPool, isDatabaseUnavailable } from "@irp/database";
import { logConnection } from "@irp/shared/connection-log";
import { QUEUES, type InvestigateJob, type AiDraftJob, type DeliverNotificationJob, type DeliverWebhookJob, type EscalateIncidentJob } from "@irp/shared";
import { handleAckTimeout } from "./ack-timeout";
import { drafterFromEnv } from "./ai-drafter";
import { generateAiDraft } from "./ai-drafts";
import { createEmailSender, type WorkerContext } from "./context";
import { handleFailures } from "./dead-letter";
import { deliverNotification } from "./delivery";
import { escalateIncident } from "./escalation";
import { Heartbeat } from "./heartbeat";
import { investigatorFromEnv } from "./investigator/investigators";
import { runInvestigation } from "./investigator/run";
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
  aiDraftsQueue: new Queue(QUEUES.aiDrafts, { connection }),
  investigationsQueue: new Queue(QUEUES.investigations, { connection }),
  drafter: drafterFromEnv(),
  investigator: investigatorFromEnv(),
  email: createEmailSender(process.env.SMTP_URL || undefined, process.env.EMAIL_FROM ?? "Fireline <pager@fireline.local>"),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  // On by default in production; .env.example turns it off for local receivers.
  blockPrivateWebhookTargets: process.env.WEBHOOK_BLOCK_PRIVATE_NETWORKS
    ? process.env.WEBHOOK_BLOCK_PRIVATE_NETWORKS === "true"
    : process.env.NODE_ENV === "production",
};
const heartbeat = new Heartbeat(ctx.redis);
logConnection("redis", ctx.redis, "work waits in Postgres; the sweeper re-drives it once Redis is back");
for (const queue of [ctx.notificationsQueue, ctx.escalationsQueue, ctx.webhooksQueue, ctx.deadLetterQueue, ctx.aiDraftsQueue, ctx.investigationsQueue]) {
  logConnection(`queue:${queue.name}`, queue);
}

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
  // "incident-created" and "escalate" walk the policy's steps; "ack-timeout"
  // is the delayed acknowledgement deadline of a high-urgency incident.
  async (job) =>
    job.name === "ack-timeout" ? handleAckTimeout(ctx, job.data.incidentId) : escalateIncident(ctx, job.data.incidentId),
  { connection, concurrency: 5 }
);

const webhooks = new Worker<DeliverWebhookJob>(
  QUEUES.webhooks,
  async (job) => deliverWebhook(ctx, job.data.deliveryId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
  { connection, concurrency: 10 }
);

// AI postmortem drafts: slow (tens of seconds) and rate-limited by the
// provider, so few at a time.
const aiDrafts = new Worker<AiDraftJob>(
  QUEUES.aiDrafts,
  async (job) => generateAiDraft(ctx, job.data.draftId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
  { connection, concurrency: 2 }
);

// Investigations: an agent making several model calls; a couple at a time.
const investigations = new Worker<InvestigateJob>(
  QUEUES.investigations,
  async (job) => runInvestigation(ctx, job.data.investigationId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
  { connection, concurrency: 2 }
);

for (const worker of [notifications, escalations, webhooks, aiDrafts, investigations]) logConnection(`worker:${worker.name}`, worker);
handleFailures(ctx, QUEUES.notifications, notifications, heartbeat.stats);
handleFailures(ctx, QUEUES.escalations, escalations, heartbeat.stats);
handleFailures(ctx, QUEUES.webhooks, webhooks, heartbeat.stats);
handleFailures(ctx, QUEUES.aiDrafts, aiDrafts, heartbeat.stats);
handleFailures(ctx, QUEUES.investigations, investigations, heartbeat.stats);

// The recovery sweep runs on a plain timer, not as a BullMQ repeatable job:
// it exists to recover from losing Redis state, so it must not live in
// Redis itself. Every replica sweeps; each step is idempotent.
let sweeping = false;
const sweepTimer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const result = await sweep(ctx);
    if (result.escalated || result.ackTimeouts || result.requeued) {
      console.log(`[sweep] escalated ${result.escalated}, ack timeouts ${result.ackTimeouts}, requeued ${result.requeued}`);
    }
  } catch (err) {
    // Usually Postgres being unreachable; one line, not a stack trace every 10 s.
    console.error(`[sweep] failed: ${isDatabaseUnavailable(err) ? "database unavailable" : err}`);
  } finally {
    sweeping = false;
  }
}, 10_000);
heartbeat.start();
console.log(
  `Worker ${heartbeat.stats.id} started: notifications, escalations, webhooks, ai-drafts (${ctx.drafter.provider}${ctx.drafter.model ? ` ${ctx.drafter.model}` : ""}), investigations (${ctx.investigator.provider}${ctx.investigator.model ? ` ${ctx.investigator.model}` : ""}) queues; sweeping every 10s.`
);

// Graceful shutdown: let in-flight jobs finish (Worker.close waits for
// them), then release connections. A job interrupted by a hard kill is
// re-delivered by BullMQ's stalled-job check, and a page or webhook that was
// mid-delivery is re-driven by the sweeper once its lease expires. If Redis or
// Postgres is down, closing could wait forever, so after 25 s we exit anyway
// (docker-compose gives the worker a 30 s stop grace period).
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down worker...");
  setTimeout(() => {
    console.error("Shutdown deadline reached; exiting with jobs still open (they will be re-delivered)");
    process.exit(1);
  }, 25_000).unref();
  clearInterval(sweepTimer);
  await Promise.all([notifications.close(), escalations.close(), webhooks.close(), aiDrafts.close(), investigations.close()]);
  await heartbeat.stop();
  await Promise.all([ctx.notificationsQueue.close(), ctx.escalationsQueue.close(), ctx.webhooksQueue.close(), ctx.deadLetterQueue.close(), ctx.aiDraftsQueue.close(), ctx.investigationsQueue.close()]);
  await ctx.redis.quit();
  await ctx.pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
