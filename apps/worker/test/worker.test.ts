import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetFixtures, setupTestDatabase, type Fixtures } from "@irp/database/testing";
import { QUEUES, type DeliverNotificationJob } from "@irp/shared";
import type { Pool } from "pg";
import type { NotificationSender, WorkerContext } from "../src/context";
import { deliverNotification } from "../src/delivery";
import { escalateIncident } from "../src/escalation";
import { sweep } from "../src/sweeper";

let pool: Pool;
let ctx: WorkerContext;
let fx: Fixtures;
const sent: { to: string; text: string }[] = [];
let failSends = false;
const sender: NotificationSender = async ({ to, text }) => {
  if (failSends) throw new Error("webhook down");
  sent.push({ to: to.name, text });
};

beforeAll(async () => {
  pool = await setupTestDatabase();
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6380");
  url.pathname = "/2"; // separate logical DB from the API tests and dev
  const connection = { url: url.toString() };
  ctx = {
    pool,
    redis: new Redis(url.toString(), { maxRetriesPerRequest: null }),
    notificationsQueue: new Queue(QUEUES.notifications, { connection }),
    escalationsQueue: new Queue(QUEUES.escalations, { connection }),
    sender,
  };
});
afterAll(async () => {
  await ctx.notificationsQueue.close();
  await ctx.escalationsQueue.close();
  await ctx.redis.quit();
  await pool.end();
});
beforeEach(async () => {
  fx = await resetFixtures(pool);
  await ctx.redis.flushdb();
  sent.length = 0;
  failSends = false;
});

// An incident on the Checkout service whose level-1 escalation is due now —
// the state the API leaves behind after opening one.
async function openIncident() {
  const { rows } = await pool.query(
    `INSERT INTO incidents (organization_id, number, service_id, title, severity, next_escalation_at)
     VALUES ($1, 1, $2, 'Checkout down', 'sev1', now()) RETURNING id`,
    [fx.orgs.acme, fx.services.checkout]
  );
  return rows[0].id as number;
}
const makeDue = (id: number) => pool.query(`UPDATE incidents SET next_escalation_at = now() - interval '1 second' WHERE id = $1`, [id]);
const notifications = async (id: number) =>
  (
    await pool.query(
      `SELECT u.name, n.kind, n.escalation_level AS level, n.status FROM notifications n
       JOIN users u ON u.id = n.user_id WHERE n.incident_id = $1 ORDER BY n.escalation_level, u.name`,
      [id]
    )
  ).rows;

describe("escalateIncident", () => {
  it("walks the escalation policy level by level until acknowledged", async () => {
    const id = await openIncident();

    await escalateIncident(ctx, id);
    expect(await notifications(id)).toEqual([{ name: "Sam", kind: "triggered", level: 1, status: "queued" }]);
    const { rows: after1 } = await pool.query(
      `SELECT escalation_level, next_escalation_at > now() + interval '50 seconds' AS next_in_a_minute FROM incidents`
    );
    expect(after1[0]).toEqual({ escalation_level: 1, next_in_a_minute: true });

    // Not due yet: nothing happens.
    expect(await escalateIncident(ctx, id)).toEqual({ paged: false, notifications: 0 });

    await makeDue(id);
    await escalateIncident(ctx, id);
    await makeDue(id);
    await escalateIncident(ctx, id); // level 3 = the Payments team (Alex + Sam)
    expect(await notifications(id)).toEqual([
      { name: "Sam", kind: "triggered", level: 1, status: "queued" },
      { name: "Alex", kind: "escalated", level: 2, status: "queued" },
      { name: "Alex", kind: "escalated", level: 3, status: "queued" },
      { name: "Sam", kind: "escalated", level: 3, status: "queued" },
    ]);
    // Last level: nothing more scheduled.
    const { rows } = await pool.query(`SELECT next_escalation_at FROM incidents`);
    expect(rows[0].next_escalation_at).toBeNull();

    const { rows: timeline } = await pool.query(`SELECT type, message FROM timeline_events ORDER BY id`);
    expect(timeline.map((e) => e.type)).toEqual(["notified", "escalated", "escalated"]);
    expect(timeline[1].message).toBe("Not acknowledged — escalated to level 2: paged Alex");
  });

  it("pages nobody twice when the same step runs concurrently", async () => {
    const id = await openIncident();
    await Promise.all(Array.from({ length: 5 }, () => escalateIncident(ctx, id)));
    expect(await notifications(id)).toHaveLength(1);
  });

  it("stops once the incident is acknowledged", async () => {
    const id = await openIncident();
    await escalateIncident(ctx, id);
    await pool.query(`UPDATE incidents SET status = 'acknowledged' WHERE id = $1`, [id]);
    await makeDue(id);
    expect((await escalateIncident(ctx, id)).paged).toBe(false);
    expect(await notifications(id)).toHaveLength(1);
    const { rows } = await pool.query(`SELECT next_escalation_at FROM incidents`);
    expect(rows[0].next_escalation_at).toBeNull();
  });

  it("enqueues delivery and the next escalation step after commit", async () => {
    const id = await openIncident();
    await escalateIncident(ctx, id);
    expect(await ctx.notificationsQueue.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
    expect(await ctx.escalationsQueue.getJobCounts("delayed")).toMatchObject({ delayed: 1 });
  });
});

describe("deliverNotification", () => {
  it("sends once and ignores redelivery", async () => {
    const id = await openIncident();
    await escalateIncident(ctx, id);
    const { rows } = await pool.query(`SELECT id FROM notifications`);

    expect(await deliverNotification(ctx, rows[0].id)).toBe("sent");
    expect(await deliverNotification(ctx, rows[0].id)).toBe("skipped");
    expect(sent).toEqual([{ to: "Sam", text: "[SEV1 · Critical] New incident: INC-1 Checkout down (Checkout API)" }]);
  });

  it("keeps the row queued for BullMQ retries and marks it failed on the last attempt", async () => {
    const id = await openIncident();
    await escalateIncident(ctx, id);
    const { rows } = await pool.query(`SELECT id FROM notifications`);
    failSends = true;

    await expect(deliverNotification(ctx, rows[0].id, false)).rejects.toThrow("webhook down");
    expect((await pool.query(`SELECT status, attempts FROM notifications`)).rows[0]).toEqual({ status: "queued", attempts: 1 });

    await expect(deliverNotification(ctx, rows[0].id, true)).rejects.toThrow();
    expect((await pool.query(`SELECT status, attempts, last_error FROM notifications`)).rows[0]).toEqual({
      status: "failed",
      attempts: 2,
      last_error: "webhook down",
    });
  });
});

describe("queue integration", () => {
  it("still delivers when a notification id is reused after an earlier job completed", async () => {
    // Regression: completed jobs used to be retained, so a later job with the
    // same id (notification-1 again after a reset) was silently dropped.
    const worker = new Worker<DeliverNotificationJob>(
      QUEUES.notifications,
      (job) => deliverNotification(ctx, job.data.notificationId),
      { connection: ctx.notificationsQueue.opts.connection }
    );
    const waitUntilSent = async () => {
      for (let i = 0; i < 100; i++) {
        const { rows } = await pool.query(`SELECT status FROM notifications WHERE id = 1`);
        if (rows[0]?.status === "sent") return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    try {
      await escalateIncident(ctx, await openIncident());
      expect(await waitUntilSent()).toBe(true);

      fx = await resetFixtures(pool); // ids restart at 1, Redis is NOT flushed
      sent.length = 0;
      await escalateIncident(ctx, await openIncident());
      expect(await waitUntilSent()).toBe(true);
      expect(sent).toHaveLength(1);
    } finally {
      await worker.close();
    }
  });
});

describe("sweep", () => {
  it("recovers overdue escalations and stuck notifications without the original jobs", async () => {
    const id = await openIncident();
    // Simulate the API having committed but never enqueued anything.
    const result = await sweep(ctx);
    expect(result.escalated).toBe(1);
    expect(await notifications(id)).toHaveLength(1);

    await pool.query(`UPDATE notifications SET created_at = now() - interval '5 minutes'`);
    await ctx.redis.flushdb(); // queue lost
    const again = await sweep(ctx);
    expect(again.requeued).toBe(1);
    expect(await ctx.notificationsQueue.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
  });
});

