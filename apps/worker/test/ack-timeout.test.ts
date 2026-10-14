import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetFixtures, setupTestDatabase, type Fixtures } from "@irp/database/testing";
import { QUEUES } from "@irp/shared";
import type { Pool } from "pg";
import { handleAckTimeout } from "../src/ack-timeout";
import type { WorkerContext } from "../src/context";
import { escalateIncident } from "../src/escalation";
import { sweep } from "../src/sweeper";

let pool: Pool;
let ctx: WorkerContext;
let fx: Fixtures;

beforeAll(async () => {
  pool = await setupTestDatabase();
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6380");
  url.pathname = "/2";
  const connection = { url: url.toString() };
  ctx = {
    pool,
    redis: new Redis(url.toString(), { maxRetriesPerRequest: null }),
    notificationsQueue: new Queue(QUEUES.notifications, { connection }),
    escalationsQueue: new Queue(QUEUES.escalations, { connection }),
    webhooksQueue: new Queue(QUEUES.webhooks, { connection }),
    deadLetterQueue: new Queue(QUEUES.deadLetter, { connection }),
    email: async () => ({ messageId: null }),
    webOrigin: "http://fireline.test",
    blockPrivateWebhookTargets: false,
  };
});
afterAll(async () => {
  await Promise.all([ctx.notificationsQueue, ctx.escalationsQueue, ctx.webhooksQueue, ctx.deadLetterQueue].map((q) => q.close()));
  await ctx.redis.quit();
  await pool.end();
});
beforeEach(async () => {
  fx = await resetFixtures(pool);
  await ctx.redis.flushdb();
  // Fixture policy: step 1 Sam (0 min), step 2 Alex (1 min), step 3 Payments team (2 min).
  // Stretch the steps so only the acknowledgement timeout can explain an early page.
  await pool.query(`UPDATE escalation_steps SET delay_minutes = delay_minutes * 10`);
  await pool.query(`UPDATE escalation_policies SET ack_timeout_minutes = 5`);
});

// A SEV1 whose step 1 has been paged and whose acknowledgement deadline
// has just passed — what the delayed job finds when it fires.
async function overdueIncident(status = "triggered") {
  const { rows } = await pool.query(
    `INSERT INTO incidents (organization_id, number, service_id, title, severity, next_escalation_at, ack_deadline_at, triggered_at)
     VALUES ($1, 1, $2, 'Checkout API unavailable', 'sev1', now(), now() - interval '1 second', now() - interval '5 minutes')
     RETURNING id`,
    [fx.orgs.acme, fx.services.checkout]
  );
  await escalateIncident(ctx, rows[0].id); // step 1: Sam
  if (status !== "triggered") await pool.query(`UPDATE incidents SET status = $2 WHERE id = $1`, [rows[0].id, status]);
  return rows[0].id as number;
}

const pages = async () =>
  (
    await pool.query(
      `SELECT u.name, n.kind, n.escalation_level AS level FROM notifications n JOIN users u ON u.id = n.user_id
       ORDER BY n.escalation_level, u.name`
    )
  ).rows;

describe("handleAckTimeout", () => {
  it("pages the next step immediately when nobody acknowledged in time", async () => {
    const id = await overdueIncident();
    const result = await handleAckTimeout(ctx, id);
    expect(result).toEqual({ timedOut: true, notifications: 1 });

    expect(await pages()).toEqual([
      { name: "Sam", kind: "triggered", level: 1 },
      { name: "Alex", kind: "escalated", level: 2 }, // due at 10 min, paged at 5
    ]);
    const { rows } = await pool.query(
      `SELECT escalation_level, ack_deadline_at, ack_timed_out_at IS NOT NULL AS timed_out,
              round(extract(epoch FROM next_escalation_at - triggered_at))::int AS step3_offset_s FROM incidents`
    );
    expect(rows[0]).toMatchObject({ escalation_level: 2, ack_deadline_at: null, timed_out: true });
    // The normal schedule continues: step 3 still at trigger + 20 min.
    expect(rows[0].step3_offset_s).toBe(20 * 60);

    const { rows: timeline } = await pool.query(`SELECT event_type, message FROM timeline_events ORDER BY id`);
    expect(timeline.slice(-2)).toEqual([
      { event_type: "ACK_TIMEOUT", message: "Not acknowledged within 5 min (SEV1 · Critical) — acknowledgement timeout expired" },
      { event_type: "INCIDENT_ESCALATED", message: "Acknowledgement timeout — escalated to level 2 early: paged Alex" },
    ]);
    expect(await ctx.notificationsQueue.getJobCounts("waiting")).toMatchObject({ waiting: 2 });
  });

  it("fires at most once, even when the job and the sweeper both run", async () => {
    const id = await overdueIncident();
    await Promise.all([handleAckTimeout(ctx, id), handleAckTimeout(ctx, id), sweep(ctx)]);
    expect(await pages()).toHaveLength(2);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM timeline_events WHERE event_type = 'ACK_TIMEOUT'`);
    expect(rows[0].n).toBe(1);
  });

  it("does nothing once the incident has been acknowledged", async () => {
    const id = await overdueIncident("acknowledged");
    expect(await handleAckTimeout(ctx, id)).toEqual({ timedOut: false, notifications: 0 });
    expect(await pages()).toHaveLength(1);
    expect((await pool.query(`SELECT ack_deadline_at FROM incidents`)).rows[0].ack_deadline_at).toBeNull();
  });

  it("does nothing before the deadline", async () => {
    const id = await overdueIncident();
    await pool.query(`UPDATE incidents SET ack_deadline_at = now() + interval '2 minutes'`);
    expect((await handleAckTimeout(ctx, id)).timedOut).toBe(false);
    expect(await pages()).toHaveLength(1);
  });

  it("is recovered by the sweeper when the delayed job was lost", async () => {
    await overdueIncident();
    await ctx.redis.flushdb(); // Redis lost the delayed job
    const result = await sweep(ctx);
    expect(result.ackTimeouts).toBe(1);
    expect(await pages()).toHaveLength(2);
  });

  it("emits incident.escalated to webhook endpoints", async () => {
    await pool.query(
      `INSERT INTO webhook_endpoints (organization_id, url, secret, events) VALUES ($1, 'https://hooks.example.com', 's', '{incident.escalated}')`,
      [fx.orgs.acme]
    );
    await handleAckTimeout(ctx, await overdueIncident());
    const { rows } = await pool.query(`SELECT event, payload FROM webhook_deliveries`);
    expect(rows).toEqual([expect.objectContaining({ event: "incident.escalated" })]);
    expect(rows[0].payload.incident.escalationLevel).toBe(2);
  });
});
