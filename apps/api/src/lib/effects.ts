import { withTransaction, type PoolClient } from "@irp/database";
import { deliverJobOptions, QUEUES, type RealtimeEvent } from "@irp/shared";
import { publishRealtime } from "@irp/shared/realtime";
import type { Deps } from "../deps";

// Side effects that must only happen once the database transaction has
// committed: pushing realtime events and enqueuing background jobs. Domain
// functions record them here while they run inside the transaction; the
// route calls flush() after COMMIT. If the transaction rolls back, nothing
// is published, so browsers and the worker never see a change that didn't
// happen.
//
// If flush itself fails (Redis down), nothing is lost: notifications are
// already rows with status 'queued' and escalations are driven by
// incidents.next_escalation_at — the worker's sweeper picks both up.
export class Effects {
  private events: { organizationId: number; event: RealtimeEvent }[] = [];
  private notificationIds: number[] = [];
  private escalateIncidentIds: number[] = [];

  publish(organizationId: number, event: RealtimeEvent) {
    this.events.push({ organizationId, event });
  }

  deliverNotification(notificationId: number) {
    this.notificationIds.push(notificationId);
  }

  escalate(incidentId: number) {
    this.escalateIncidentIds.push(incidentId);
  }

  async flush(deps: Pick<Deps, "redis" | "queues">) {
    try {
      for (const { organizationId, event } of this.events) {
        await publishRealtime(deps.redis, organizationId, event);
      }
      for (const id of this.notificationIds) {
        await deps.queues.notifications.add(
          "deliver",
          { notificationId: id },
          deliverJobOptions(id)
        );
      }
      for (const id of this.escalateIncidentIds) {
        await deps.queues.escalations.add(QUEUES.escalations, { incidentId: id }, { removeOnComplete: true, removeOnFail: 100 });
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
