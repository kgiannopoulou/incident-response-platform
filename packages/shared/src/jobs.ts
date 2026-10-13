// BullMQ queue names and job payloads, shared by the API (producer) and the
// worker (consumer). Jobs only carry ids: the worker always re-reads the
// current state from Postgres, so a delayed or retried job can't act on
// stale data.

export const QUEUES = {
  notifications: "notifications",
  escalations: "escalations",
} as const;

export type DeliverNotificationJob = { notificationId: number };
export type EscalateIncidentJob = { incidentId: number };

// BullMQ deduplicates jobs by id, so enqueuing the same notification twice
// (API after commit + worker's recovery sweep) delivers it once.
export const notificationJobId = (notificationId: number) => `notification-${notificationId}`;

// Options for every "deliver" job, wherever it is enqueued. Finished jobs
// are removed: delivery status is tracked in Postgres, and a retained
// completed job would make BullMQ silently ignore any later job with the
// same id (e.g. after ids are reused), so dedup must only apply to jobs
// that are still in flight.
export function deliverJobOptions(notificationId: number) {
  return {
    jobId: notificationJobId(notificationId),
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}
