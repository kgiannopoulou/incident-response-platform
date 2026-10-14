// BullMQ queue names and job payloads, shared by the API (producer) and the
// worker (consumer). Jobs only carry ids: the worker always re-reads the
// current state from Postgres, so a delayed or retried job can't act on
// stale data.
//
//   API ── save incident (COMMIT) ──► escalations: "incident-created" { incidentId }
//                                          │  worker pages step 1, schedules step 2 (delayed job)
//                                          ▼
//                                     notifications: "deliver" { notificationId }   (email)
//                                     webhooks: "deliver-webhook" { deliveryId }      (signed POST)
//                                          │  5 attempts, exponential backoff
//                                          ▼  still failing
//                                     dead-letter: the job, its error and attempts — kept for
//                                     an operator to inspect, retry or discard

export const QUEUES = {
  notifications: "notifications",
  escalations: "escalations",
  webhooks: "webhooks",
  deadLetter: "dead-letter",
} as const;

// Queues whose failed jobs are dead-lettered (everything except the DLQ itself).
export const WORK_QUEUES = [QUEUES.notifications, QUEUES.escalations, QUEUES.webhooks] as const;
export type WorkQueue = (typeof WORK_QUEUES)[number];

export type DeliverNotificationJob = { notificationId: number };
export type EscalateIncidentJob = { incidentId: number };
export type DeliverWebhookJob = { deliveryId: number };

// A job that used up every retry. Stored as the payload of a job in the
// dead-letter queue (which no worker consumes), so the original data and
// the reason it failed survive for inspection and a manual retry.
export type DeadLetterJob = {
  queue: WorkQueue;
  name: string;
  jobId: string | null;
  data: Record<string, unknown>;
  failedReason: string;
  attemptsMade: number;
  failedAt: string; // ISO
};

// Retry policy per queue. Delays grow exponentially: 2 s, 4 s, 8 s, 16 s for
// a page — long enough to ride out a webhook/SMTP blip, short enough that a
// page is never minutes late. Escalation steps retry faster because they
// only touch Postgres. Webhooks wait longer between tries (5 s → 40 s):
// the receiver is someone else's server, which may be restarting.
export const RETRY_POLICY: Record<WorkQueue, { attempts: number; backoff: { type: "exponential"; delay: number } }> = {
  notifications: { attempts: 5, backoff: { type: "exponential", delay: 2000 } },
  escalations: { attempts: 5, backoff: { type: "exponential", delay: 1000 } },
  webhooks: { attempts: 5, backoff: { type: "exponential", delay: 5000 } },
};

// Backoff before retry number `attempt` (1-based), as BullMQ computes it.
export function backoffDelay(queue: WorkQueue, attempt: number) {
  return RETRY_POLICY[queue].backoff.delay * 2 ** (attempt - 1);
}

// BullMQ deduplicates jobs by id, so enqueuing the same notification twice
// (API after commit + worker's recovery sweep) delivers it once.
export const notificationJobId = (notificationId: number) => `notification-${notificationId}`;

// Options for every "deliver" job, wherever it is enqueued. Finished jobs
// are removed: delivery status is tracked in Postgres, and a retained
// completed job would make BullMQ silently ignore any later job with the
// same id (e.g. after ids are reused), so dedup must only apply to jobs
// that are still in flight. Failed jobs are removed too — the worker copies
// them to the dead-letter queue first.
export function deliverJobOptions(notificationId: number) {
  return {
    jobId: notificationJobId(notificationId),
    ...RETRY_POLICY.notifications,
    removeOnComplete: true,
    removeOnFail: true,
  };
}

export const webhookJobId = (deliveryId: number) => `webhook-${deliveryId}`;

// Same dedup and cleanup rules as page deliveries.
export function webhookJobOptions(deliveryId: number) {
  return {
    jobId: webhookJobId(deliveryId),
    ...RETRY_POLICY.webhooks,
    removeOnComplete: true,
    removeOnFail: true,
  };
}

// Options for escalation jobs. `delay` schedules the next step.
export function escalateJobOptions(delay = 0) {
  return { delay, ...RETRY_POLICY.escalations, removeOnComplete: true, removeOnFail: true };
}

// Workers announce themselves with a short-lived key, refreshed while they
// run; `/health` and the System page count the live ones.
export const WORKER_HEARTBEAT_PREFIX = "irp:worker:";
export const WORKER_HEARTBEAT_TTL_SECONDS = 30;
export type WorkerHeartbeat = {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  processed: number;
  failed: number;
  deadLettered: number;
};
