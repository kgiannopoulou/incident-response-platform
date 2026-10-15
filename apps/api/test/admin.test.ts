import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { WORKER_HEARTBEAT_PREFIX } from "@irp/shared";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const api = () => request(t.app);
const critical = { title: "Checkout down", severity: "critical", source: "probe" };

// A page that exhausted its retries: a 'failed' notification row plus the
// dead-letter entry the worker would have written for it.
async function deadLetteredPage(organizationId = t.fx.orgs.acme) {
  await t.alert(TEST_KEYS.checkout, critical);
  const { rows } = await t.deps.pool.query(
    `INSERT INTO notifications (incident_id, user_id, kind, escalation_level, status, attempts, last_error)
     VALUES (1, $1, 'triggered', 1, 'failed', 5, 'SMTP timeout') RETURNING id`,
    [t.fx.users.sam]
  );
  const job = await t.deps.queues.deadLetter.add("notifications:deliver", {
    queue: "notifications",
    name: "deliver",
    jobId: `notification-${rows[0].id}`,
    data: { notificationId: rows[0].id },
    failedReason: "SMTP timeout",
    attemptsMade: 5,
    failedAt: new Date().toISOString(),
    organizationId,
  });
  return { notificationId: rows[0].id as number, jobId: job.id! };
}

describe("queue overview", () => {
  it("shows job counts per queue and the live workers, to admins only", async () => {
    await t.deps.redis.set(
      `${WORKER_HEARTBEAT_PREFIX}host:123`,
      JSON.stringify({ id: "host:123", processed: 7, failed: 1, deadLettered: 0 }),
      "EX",
      30
    );
    await t.alert(TEST_KEYS.checkout, critical);

    expect((await api().get("/api/v1/admin/queues").set(await t.as("sam"))).status).toBe(403);
    const res = await api().get("/api/v1/admin/queues").set(await t.as("alex"));
    expect(res.status).toBe(200);
    expect(res.body.queues.map((q: { name: string }) => q.name)).toEqual(["notifications", "escalations", "webhooks", "ai-drafts", "dead-letter"]);
    // The new incident's "incident-created" job is waiting for a worker.
    const escalations = res.body.queues.find((q: { name: string }) => q.name === "escalations");
    expect(escalations.counts.waiting).toBe(1);
    expect(res.body.workers).toEqual([expect.objectContaining({ id: "host:123", processed: 7 })]);

    const health = await api().get("/health");
    expect(health.body).toMatchObject({ ok: true, workers: 1 });
  });

  it("queues an incident-created job with retries instead of paging inside the request", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const [job] = await t.deps.queues.escalations.getJobs(["waiting"]);
    expect(job.name).toBe("incident-created");
    expect(job.data).toEqual({ incidentId: 1 });
    expect(job.opts).toMatchObject({ attempts: 5, backoff: { type: "exponential", delay: 1000 } });
    // Nobody has been paged yet: that's the worker's job.
    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n FROM notifications`);
    expect(rows[0].n).toBe(0);
  });
});

describe("dead-letter queue", () => {
  it("lists dead letters for the caller's organization only", async () => {
    await deadLetteredPage();
    const alex = await api().get("/api/v1/admin/dead-letter").set(await t.as("alex"));
    expect(alex.body.entries).toEqual([
      expect.objectContaining({ queue: "notifications", failedReason: "SMTP timeout", attemptsMade: 5 }),
    ]);
    const eve = await api().get("/api/v1/admin/dead-letter").set(await t.as("eve"));
    expect(eve.body.entries).toEqual([]);
  });

  it("retries a failed page: the row is queued again and a delivery job is enqueued", async () => {
    const { notificationId, jobId } = await deadLetteredPage();
    expect((await api().post(`/api/v1/admin/dead-letter/${jobId}/retry`).set(await t.as("eve"))).status).toBe(404);

    const res = await api().post(`/api/v1/admin/dead-letter/${jobId}/retry`).set(await t.as("alex"));
    expect(res.status).toBe(200);
    const { rows } = await t.deps.pool.query(`SELECT status, attempts, last_error FROM notifications WHERE id = $1`, [notificationId]);
    expect(rows[0]).toEqual({ status: "queued", attempts: 0, last_error: null });
    expect(await t.deps.queues.notifications.getJob(`notification-${notificationId}`)).toBeTruthy();
    expect(await t.deps.queues.deadLetter.getJobCounts("waiting")).toMatchObject({ waiting: 0 });

    // The entry is gone once retried.
    expect((await api().post(`/api/v1/admin/dead-letter/${jobId}/retry`).set(await t.as("alex"))).status).toBe(404);
    const { rows: audit } = await t.deps.pool.query(`SELECT action FROM audit_log WHERE action LIKE 'dead_letter.%'`);
    expect(audit).toEqual([{ action: "dead_letter.retry" }]);
  });

  it("discards a dead letter", async () => {
    const { jobId } = await deadLetteredPage();
    await api().delete(`/api/v1/admin/dead-letter/${jobId}`).set(await t.as("alex")).expect(204);
    expect(await t.deps.queues.deadLetter.getJobCounts("waiting")).toMatchObject({ waiting: 0 });
  });
});
