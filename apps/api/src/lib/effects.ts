import { withTransaction, type PoolClient } from "@irp/database";
import {
  ackTimeoutJobId,
  aiDraftJobOptions,
  ackTimeoutJobOptions,
  deliverJobOptions,
  escalateJobOptions,
  webhookJobOptions,
  type RealtimeEvent,
} from "@irp/shared";
import { publishRealtime } from "@irp/shared/realtime";
import type { Deps } from "../deps";
import { logDegraded, redisIsDown, withTimeout } from "./resilience";

// The whole flush must finish within this, or we give up on what's left.
const FLUSH_DEADLINE_MS = 2_000;

// Side effects that must only happen once the database transaction has
// committed: pushing realtime events and enqueuing background jobs. Domain
// functions record them here while they run inside the transaction; the
// route calls flush() after COMMIT. If the transaction rolls back, nothing
// is published, so browsers and the worker never see a change that didn't
// happen.
//
// If flush itself fails or times out (Redis down), nothing is lost:
// notifications and webhook deliveries are already rows with status 'queued',
// escalations and acknowledgement deadlines are driven by
// incidents.next_escalation_at / ack_deadline_at, and AI drafts are 'queued'
// rows — the worker's sweeper picks all of them up. Only live browser updates
// are lost, and browsers resync when their stream reconnects. The deadline
// keeps a Redis outage from holding the HTTP response of an alert that is
// already committed.
export class Effects {
  private events: { organizationId: number; event: RealtimeEvent }[] = [];
  private notificationIds: number[] = [];
  private webhookDeliveryIds: number[] = [];
  private escalations: { incidentId: number; name: string }[] = [];
  private ackTimeouts: { incidentId: number; at: Date }[] = [];
  private cancelledAckTimeouts: number[] = [];
  private aiDrafts: number[] = [];

  publish(organizationId: number, event: RealtimeEvent) {
    this.events.push({ organizationId, event });
  }

  deliverNotification(notificationId: number) {
    this.notificationIds.push(notificationId);
  }

  deliverWebhooks(deliveryIds: number[]) {
    this.webhookDeliveryIds.push(...deliveryIds);
  }

  // "incident-created" for a brand-new incident (the worker pages step 1),
  // "escalate" when a later step was rescheduled.
  escalate(incidentId: number, name: "incident-created" | "escalate" = "escalate") {
    this.escalations.push({ incidentId, name });
  }

  // Delayed job that fires when an unacknowledged high-urgency incident's
  // acknowledgement deadline passes.
  scheduleAckTimeout(incidentId: number, at: Date) {
    this.ackTimeouts.push({ incidentId, at });
  }

  // Acknowledged in time: drop the pending job. Best effort — the worker
  // re-checks the incident anyway, so a job that can't be removed (already
  // running) finds nothing to do.
  cancelAckTimeout(incidentId: number) {
    this.cancelledAckTimeouts.push(incidentId);
  }

  // Ask the worker to write an AI postmortem draft (a row already exists).
  generateAiDraft(draftId: number) {
    this.aiDrafts.push(draftId);
  }

  async flush(deps: Pick<Deps, "redis" | "queues">) {
    try {
      if (redisIsDown(deps.redis)) throw new Error("Redis connection lost");
      await withTimeout(this.run(deps), FLUSH_DEADLINE_MS, "post-commit side effects");
    } catch (err) {
      logDegraded("post-commit side effects failed; the worker sweeper will recover", err);
    }
  }

  // Jobs first: a page matters more than a live browser update.
  private async run(deps: Pick<Deps, "redis" | "queues">) {
    for (const id of this.notificationIds) {
      await deps.queues.notifications.add("deliver", { notificationId: id }, deliverJobOptions(id));
    }
    for (const id of this.webhookDeliveryIds) {
      await deps.queues.webhooks.add("deliver-webhook", { deliveryId: id }, webhookJobOptions(id));
    }
    for (const { incidentId, name } of this.escalations) {
      await deps.queues.escalations.add(name, { incidentId }, escalateJobOptions());
    }
    for (const { incidentId, at } of this.ackTimeouts) {
      const delay = Math.max(0, at.getTime() - Date.now());
      await deps.queues.escalations.add("ack-timeout", { incidentId }, ackTimeoutJobOptions(incidentId, delay));
    }
    for (const incidentId of this.cancelledAckTimeouts) {
      await deps.queues.escalations.remove(ackTimeoutJobId(incidentId)).catch(() => 0);
    }
    for (const draftId of this.aiDrafts) {
      await deps.queues.aiDrafts.add("draft-postmortem", { draftId }, aiDraftJobOptions(draftId));
    }
    for (const { organizationId, event } of this.events) {
      await publishRealtime(deps.redis, organizationId, event);
    }
  }
}

// Runs `fn` in a transaction with a fresh Effects collector and flushes the
// collected side effects only after COMMIT.
export async function runTx<T>(
  deps: Pick<Deps, "pool" | "redis" | "queues">,
  fn: (db: PoolClient, fx: Effects) => Promise<T>
): Promise<T> {
  const fx = new Effects();
  const result = await withTransaction(deps.pool, (db) => fn(db, fx));
  await fx.flush(deps);
  return result;
}
