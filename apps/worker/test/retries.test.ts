import http from "node:http";
import type { AddressInfo } from "node:net";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queueWebhookEvent, withTransaction } from "@irp/database";
import { resetFixtures, setupTestDatabase, type Fixtures } from "@irp/database/testing";
import {
  aiDraftJobOptions,
  deliverJobOptions,
  QUEUES,
  RETRY_POLICY,
  ruleBasedPostmortemDraft,
  webhookJobOptions,
  type AiDraftJob,
  type DeliverNotificationJob,
  type DeliverWebhookJob,
} from "@irp/shared";
import type { Pool } from "pg";
import { rulesDrafter, type PostmortemDrafter } from "../src/ai-drafter";
import { generateAiDraft } from "../src/ai-drafts";
import type { EmailSender, WorkerContext } from "../src/context";
import { handleFailures } from "../src/dead-letter";
import { deliverNotification } from "../src/delivery";
import { escalateIncident } from "../src/escalation";
import { deliverWebhook } from "../src/webhooks";

// Phase 20: "notification attempt 1 → failure, attempt 2 → failure,
// attempt 3 → success" — with real BullMQ workers, the production job
// options (attempts, removeOnComplete/Fail, job ids) and the production
// handlers, wired exactly like src/index.ts. Only the backoff delay is
// shortened so the test takes milliseconds instead of 6 seconds.

let pool: Pool;
let ctx: WorkerContext;
let fx: Fixtures;
let connection: { url: string };
let script: ("fail" | "ok")[] = [];
const attempts: { call: number; rowBefore: { status: string; attempts: number } }[] = [];
const delivered: string[] = [];

const scriptedEmail: EmailSender = async ({ to }) => {
  const call = attempts.length + 1;
  const { rows } = await pool.query(`SELECT status, attempts FROM notifications ORDER BY id LIMIT 1`);
  attempts.push({ call, rowBefore: rows[0] });
  if ((script[call - 1] ?? "ok") === "fail") throw new Error(`SMTP 421 try again later (attempt ${call})`);
  delivered.push(to.name);
  return { messageId: `<${call}@test>` };
};

let respond: number[] = [];
let hits = 0;
const receiver = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => res.writeHead(respond[hits++] ?? 200).end());
});

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  pool = await setupTestDatabase();
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6380");
  url.pathname = "/2";
  connection = { url: url.toString() };
  ctx = {
    pool,
    redis: new Redis(url.toString(), { maxRetriesPerRequest: null }),
    notificationsQueue: new Queue(QUEUES.notifications, { connection }),
    escalationsQueue: new Queue(QUEUES.escalations, { connection }),
    webhooksQueue: new Queue(QUEUES.webhooks, { connection }),
    deadLetterQueue: new Queue(QUEUES.deadLetter, { connection }),
    aiDraftsQueue: new Queue(QUEUES.aiDrafts, { connection }),
    drafter: rulesDrafter,
    email: scriptedEmail,
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
  script = [];
  attempts.length = 0;
  delivered.length = 0;
  respond = [];
  hits = 0;
});

const fast = { backoff: { type: "exponential" as const, delay: 20 } };

// Runs one queue's worker (with dead-lettering, as in production) until
// the job finishes for good: completed, or failed on its last attempt.
async function runUntilSettled<T>(queue: string, handler: (job: Job<T>) => Promise<unknown>, enqueue: () => Promise<unknown>) {
  const stats = { processed: 0, failed: 0, deadLettered: 0 };
  const failures: number[] = [];
  const worker = new Worker<T>(queue, handler, { connection });
  handleFailures(ctx, queue as never, worker, stats);
  const settled = new Promise<{ outcome: "completed" | "failed"; attemptsMade: number }>((resolve) => {
    worker.on("completed", (job) => resolve({ outcome: "completed", attemptsMade: job.attemptsMade }));
    worker.on("failed", (job) => {
      failures.push(job!.attemptsMade);
      if (job!.attemptsMade >= (job!.opts.attempts ?? 1)) setTimeout(() => resolve({ outcome: "failed", attemptsMade: job!.attemptsMade }), 100);
    });
  });
  await enqueue();
  try {
    const result = await settled;
    return { ...result, failures, stats };
  } finally {
    await worker.close();
  }
}

async function queuedPage() {
  const { rows } = await pool.query(
    `INSERT INTO incidents (organization_id, number, service_id, title, severity, next_escalation_at)
     VALUES ($1, 1, $2, 'Checkout down', 'sev1', now()) RETURNING id`,
    [fx.orgs.acme, fx.services.checkout]
  );
  await escalateIncident(ctx, rows[0].id); // writes the 'queued' notification for Sam
  const id = (await pool.query(`SELECT id FROM notifications`)).rows[0].id as number;
  // escalateIncident already enqueued its delivery job; drop it so the test's
  // copy (same id, shorter backoff) is the one that runs.
  await ctx.notificationsQueue.remove(`notification-${id}`);
  return id;
}

describe("worker retries", () => {
  it("uses the documented retry policy for every queue", () => {
    expect(deliverJobOptions(1)).toMatchObject({ attempts: 5, backoff: { type: "exponential", delay: 2000 } });
    expect(webhookJobOptions(1)).toMatchObject({ attempts: 5, backoff: { type: "exponential", delay: 5000 } });
    expect(aiDraftJobOptions(1)).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 15_000 } });
    expect(Object.keys(RETRY_POLICY).sort()).toEqual(["ai-drafts", "escalations", "notifications", "webhooks"]);
  });

  it("page: attempt 1 → failure, attempt 2 → failure, attempt 3 → success", async () => {
    const notificationId = await queuedPage();
    script = ["fail", "fail", "ok"];

    const run = await runUntilSettled<DeliverNotificationJob>(
      QUEUES.notifications,
      (job) => deliverNotification(ctx, job.data.notificationId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
      () => ctx.notificationsQueue.add("deliver", { notificationId }, { ...deliverJobOptions(notificationId), ...fast })
    );

    expect(run).toMatchObject({ outcome: "completed", attemptsMade: 3, failures: [1, 2] });
    // The row stayed 'queued' between attempts (so each retry actually sends) …
    expect(attempts.map((a) => a.rowBefore)).toEqual([
      { status: "queued", attempts: 0 },
      { status: "queued", attempts: 1 },
      { status: "queued", attempts: 2 },
    ]);
    // … and ends 'sent' after the third attempt, with the error cleared.
    const { rows } = await pool.query(`SELECT status, attempts, last_error, provider_message_id FROM notifications WHERE id = $1`, [notificationId]);
    expect(rows[0]).toEqual({ status: "sent", attempts: 3, last_error: null, provider_message_id: "<3@test>" });
    expect(delivered).toEqual(["Sam"]); // paged exactly once
    expect(run.stats.deadLettered).toBe(0);
    expect(await ctx.deadLetterQueue.count()).toBe(0);
  });

  it("page: every attempt fails → marked failed and dead-lettered once", async () => {
    const notificationId = await queuedPage();
    script = ["fail", "fail", "fail", "fail", "fail"];
    const run = await runUntilSettled<DeliverNotificationJob>(
      QUEUES.notifications,
      (job) => deliverNotification(ctx, job.data.notificationId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
      () => ctx.notificationsQueue.add("deliver", { notificationId }, { ...deliverJobOptions(notificationId), ...fast })
    );
    expect(run).toMatchObject({ outcome: "failed", attemptsMade: 5, failures: [1, 2, 3, 4, 5] });
    expect((await pool.query(`SELECT status, attempts FROM notifications`)).rows[0]).toEqual({ status: "failed", attempts: 5 });
    const [dead] = await ctx.deadLetterQueue.getJobs(["waiting"]);
    expect(dead.data).toMatchObject({ queue: "notifications", attemptsMade: 5, organizationId: fx.orgs.acme, failedReason: "SMTP 421 try again later (attempt 5)" });
    expect(delivered).toEqual([]);
  });

  it("webhook: 500 → 500 → 200 is delivered on the third attempt", async () => {
    const { rows } = await pool.query(
      `INSERT INTO incidents (organization_id, number, service_id, title, severity) VALUES ($1, 1, $2, 'Checkout down', 'sev1') RETURNING id`,
      [fx.orgs.acme, fx.services.checkout]
    );
    await pool.query(`INSERT INTO webhook_endpoints (organization_id, url, secret, events) VALUES ($1, $2, 'whsec_t', $3)`, [
      fx.orgs.acme,
      `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`,
      ["incident.triggered"],
    ]);
    const [deliveryId] = await withTransaction(pool, (db) => queueWebhookEvent(db, "incident.triggered", rows[0].id));
    respond = [500, 500, 200];

    const run = await runUntilSettled<DeliverWebhookJob>(
      QUEUES.webhooks,
      (job) => deliverWebhook(ctx, job.data.deliveryId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
      () => ctx.webhooksQueue.add("deliver-webhook", { deliveryId }, { ...webhookJobOptions(deliveryId), ...fast })
    );
    expect(run).toMatchObject({ outcome: "completed", failures: [1, 2] });
    expect(hits).toBe(3);
    const { rows: delivery } = await pool.query(`SELECT status, attempts, response_status FROM webhook_deliveries`);
    expect(delivery[0]).toMatchObject({ status: "sent", attempts: 3, response_status: 200 });
  });

  it("AI draft: two provider errors, then a draft", async () => {
    const { rows } = await pool.query(
      `INSERT INTO incidents (organization_id, number, service_id, title, severity, status, resolved_at)
       VALUES ($1, 1, $2, 'Checkout down', 'sev1', 'resolved', now()) RETURNING id`,
      [fx.orgs.acme, fx.services.checkout]
    );
    await pool.query(`INSERT INTO timeline_events (incident_id, event_type, message) VALUES ($1, 'INCIDENT_CREATED', 'opened')`, [rows[0].id]);
    const { rows: draft } = await pool.query(`INSERT INTO postmortem_ai_drafts (organization_id, incident_id) VALUES ($1, $2) RETURNING id`, [
      fx.orgs.acme,
      rows[0].id,
    ]);
    let calls = 0;
    const flaky: PostmortemDrafter = {
      provider: "claude",
      model: "claude-opus-5-5",
      async draft(context) {
        if (++calls < 3) throw new Error("529 overloaded");
        return { output: ruleBasedPostmortemDraft(context), model: "claude-opus-5-5" };
      },
    };
    ctx.drafter = flaky;
    try {
      const run = await runUntilSettled<AiDraftJob>(
        QUEUES.aiDrafts,
        (job) => generateAiDraft(ctx, job.data.draftId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
        () => ctx.aiDraftsQueue.add("draft-postmortem", { draftId: draft[0].id }, { ...aiDraftJobOptions(draft[0].id), ...fast })
      );
      expect(run).toMatchObject({ outcome: "completed", failures: [1, 2] });
    } finally {
      ctx.drafter = rulesDrafter;
    }
    const { rows: row } = await pool.query(`SELECT status, attempts, error FROM postmortem_ai_drafts`);
    expect(row[0]).toEqual({ status: "ready", attempts: 3, error: null });
  });
});
