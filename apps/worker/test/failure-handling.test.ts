import http from "node:http";
import type { AddressInfo } from "node:net";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queueWebhookEvent, withTransaction } from "@irp/database";
import { resetFixtures, setupTestDatabase, type Fixtures } from "@irp/database/testing";
import { notificationJobId, QUEUES, webhookJobId } from "@irp/shared";
import type { Pool } from "pg";
import type { EmailMessage, WorkerContext } from "../src/context";
import { claimLease, deliverNotification, pageMessageId } from "../src/delivery";
import { escalateIncident } from "../src/escalation";
import { sweep } from "../src/sweeper";
import { deliverWebhook } from "../src/webhooks";
import { rulesDrafter } from "../src/ai-drafter";

// Phase 21, worker side: duplicate jobs, concurrent workers and a worker
// that dies half-way through a delivery. Pages and webhooks are delivered
// at least once, never twice in parallel, and never silently dropped.

let received: string[] = [];
const receiver = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    received.push(String(req.headers["fireline-delivery"]));
    // A slow receiver widens the window in which a duplicate could slip in.
    setTimeout(() => res.writeHead(200).end(), 50);
  });
});
let receiverUrl: string;

let pool: Pool;
let ctx: WorkerContext;
let fx: Fixtures;
const emails: EmailMessage[] = [];
let emailDelayMs = 0;
let failNextEmail = false;

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
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
    aiDraftsQueue: new Queue(QUEUES.aiDrafts, { connection }),
    drafter: rulesDrafter,
    email: async (message) => {
      if (failNextEmail) {
        failNextEmail = false;
        throw new Error("SMTP 421 try again later");
      }
      await new Promise((r) => setTimeout(r, emailDelayMs));
      emails.push(message);
      return { messageId: message.messageId ?? null };
    },
    webOrigin: "http://fireline.test",
    blockPrivateWebhookTargets: false,
  };
});
afterAll(async () => {
  await Promise.all([ctx.notificationsQueue, ctx.escalationsQueue, ctx.webhooksQueue, ctx.deadLetterQueue, ctx.aiDraftsQueue].map((q) => q.close()));
  await ctx.redis.quit();
  await pool.end();
  receiver.close();
});
beforeEach(async () => {
  fx = await resetFixtures(pool);
  await ctx.redis.flushdb();
  received = [];
  emails.length = 0;
  emailDelayMs = 0;
  failNextEmail = false;
});

// An incident whose first escalation step has paged Sam: one queued page.
async function queuedPage() {
  const { rows } = await pool.query(
    `INSERT INTO incidents (organization_id, number, service_id, title, severity, next_escalation_at)
     VALUES ($1, 1, $2, 'Checkout down', 'sev1', now()) RETURNING id`,
    [fx.orgs.acme, fx.services.checkout]
  );
  await escalateIncident(ctx, rows[0].id);
  const { rows: n } = await pool.query(`SELECT id FROM notifications`);
  expect(n).toHaveLength(1);
  await ctx.redis.flushdb(); // forget the deliver job escalateIncident queued: tests drive delivery themselves
  return { incidentId: rows[0].id as number, notificationId: n[0].id as number };
}
const ageRows = (table: string) => pool.query(`UPDATE ${table} SET created_at = now() - interval '5 minutes'`);
const row = async (table: string, id: number) =>
  (await pool.query(`SELECT status, attempts, delivering_until IS NOT NULL AS leased FROM ${table} WHERE id = $1`, [id])).rows[0];

describe("pages: what if the same job runs twice, or the worker crashes half-way?", () => {
  it("five workers delivering the same page at once send one email", async () => {
    const { notificationId } = await queuedPage();
    emailDelayMs = 50;
    const results = await Promise.all(Array.from({ length: 5 }, () => deliverNotification(ctx, notificationId)));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === "skipped")).toHaveLength(4);
    expect(emails).toHaveLength(1);
    expect(await row("notifications", notificationId)).toEqual({ status: "sent", attempts: 1, leased: false });
  });

  it("a failed attempt releases its lease so the BullMQ retry can send", async () => {
    const { notificationId } = await queuedPage();
    failNextEmail = true;
    await expect(deliverNotification(ctx, notificationId, false)).rejects.toThrow("SMTP 421");
    expect(await row("notifications", notificationId)).toEqual({ status: "queued", attempts: 1, leased: false });
    expect(await deliverNotification(ctx, notificationId, false)).toBe("sent");
    expect(emails).toHaveLength(1);
  });

  it("a worker that died mid-send: the sweeper leaves it alone while the lease runs, then re-drives it once", async () => {
    const { notificationId } = await queuedPage();
    await ageRows("notifications");
    // The crashed worker took the lease (and maybe sent the email) but never
    // recorded the outcome.
    expect(await claimLease(ctx, "notifications", notificationId)).toBe(true);

    // Another job for the same row (stalled-job redelivery) must not send in parallel.
    expect(await deliverNotification(ctx, notificationId)).toBe("skipped");
    await sweep(ctx);
    expect(await ctx.notificationsQueue.getJob(notificationJobId(notificationId))).toBeUndefined();

    // Lease expired: the sweeper re-enqueues and the page goes out.
    await pool.query(`UPDATE notifications SET delivering_until = now() - interval '1 second'`);
    await sweep(ctx);
    expect(await ctx.notificationsQueue.getJob(notificationJobId(notificationId))).toBeDefined();
    expect(await deliverNotification(ctx, notificationId)).toBe("sent");
    expect(await deliverNotification(ctx, notificationId)).toBe("skipped"); // and only once
    expect(emails).toHaveLength(1);
  });

  it("gives every page a stable Message-ID, so a re-sent copy is recognisably the same email", async () => {
    const { notificationId } = await queuedPage();
    await deliverNotification(ctx, notificationId);
    expect(emails[0].messageId).toBe(pageMessageId(notificationId));
    expect(emails[0].messageId).toBe(`<page-${notificationId}@fireline.local>`);
    const { rows } = await pool.query(`SELECT provider_message_id FROM notifications`);
    expect(rows[0].provider_message_id).toBe(emails[0].messageId);
  });
});

describe("webhooks: same guarantees", () => {
  async function queuedDelivery() {
    const { incidentId } = await queuedPage();
    await pool.query(`INSERT INTO webhook_endpoints (organization_id, url, secret, events) VALUES ($1, $2, 'whsec_x', '{incident.triggered}')`, [
      fx.orgs.acme,
      receiverUrl,
    ]);
    const [deliveryId] = await withTransaction(pool, (db) => queueWebhookEvent(db, "incident.triggered", incidentId));
    return deliveryId;
  }

  it("three workers delivering the same webhook at once make one POST", async () => {
    const deliveryId = await queuedDelivery();
    const results = await Promise.all([1, 2, 3].map(() => deliverWebhook(ctx, deliveryId)));
    expect(results.sort()).toEqual(["sent", "skipped", "skipped"]);
    expect(received).toEqual([String(deliveryId)]);
    expect(await row("webhook_deliveries", deliveryId)).toEqual({ status: "sent", attempts: 1, leased: false });
  });

  it("re-drives a delivery whose worker died, after the lease expires", async () => {
    const deliveryId = await queuedDelivery();
    await ageRows("webhook_deliveries");
    await claimLease(ctx, "webhook_deliveries", deliveryId);
    await sweep(ctx);
    expect(await ctx.webhooksQueue.getJob(webhookJobId(deliveryId))).toBeUndefined();
    await pool.query(`UPDATE webhook_deliveries SET delivering_until = now() - interval '1 second'`);
    await sweep(ctx);
    expect(await ctx.webhooksQueue.getJob(webhookJobId(deliveryId))).toBeDefined();
  });
});

describe("sweeper housekeeping", () => {
  it("drops alert idempotency keys after 24 hours", async () => {
    await pool.query(
      `INSERT INTO alert_idempotency_keys (service_id, key, request_hash, created_at)
       VALUES ($1, 'old', 'h', now() - interval '25 hours'), ($1, 'fresh', 'h', now())`,
      [fx.services.checkout]
    );
    await sweep(ctx);
    const { rows } = await pool.query(`SELECT key FROM alert_idempotency_keys`);
    expect(rows).toEqual([{ key: "fresh" }]);
  });
});
