import { withTransaction, type PoolClient } from "@irp/database";
import {
  ackTimeoutJobId,
  ackTimeoutJobOptions,
  deliverJobOptions,
  escalateJobOptions,
  webhookJobOptions,
  type RealtimeEvent,
} from "@irp/shared";
import { publishRealtime } from "@irp/shared/realtime";
import type { Deps } from "../deps";

// Side effects that must only happen once the database transaction has
// committed: pushing realtime events and enqueuing background jobs. Domain
// functions record them here while they run inside the transaction; the
// route calls flush() after COMMIT. If the transaction rolls back, nothing
// is published, so browsers and the worker never see a change that didn't
// happen.
//
// If flush itself fails (Redis down), nothing is lost: notifications and
// webhook deliveries are already rows with status 'queued' and escalations are driven by
// incidents.next_escalation_at — the worker's sweeper picks both up.
export class Effects {
  private events: { organizationId: number; event: RealtimeEvent }[] = [];
  private notificationIds: number[] = [];
  private webhookDeliveryIds: number[] = [];
  private escalations: { incidentId: number; name: string }[] = [];
  private ackTimeouts: { incidentId: number; at: Date }[] = [];
  private cancelledAckTimeouts: number[] = [];

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

  async flush(deps: Pick<Deps, "redis" | "queues">) {
    try {
      for (const { organizationId, event } of this.events) {
        await publishRealtime(deps.redis, organizationId, event);
      }
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
    } catch (err) {
      console.error("Post-commit side effects failed; the worker sweeper will recover:", err);
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
