import http from "node:http";
import type { AddressInfo } from "node:net";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queueWebhookEvent, withTransaction } from "@irp/database";
import { resetFixtures, setupTestDatabase, type Fixtures } from "@irp/database/testing";
import { QUEUES } from "@irp/shared";
import { verifyWebhookSignature } from "@irp/shared/crypto";
import type { Pool } from "pg";
import type { EmailMessage, WorkerContext } from "../src/context";
import { deliverNotification } from "../src/delivery";
import { escalateIncident } from "../src/escalation";
import { deliverWebhook, isPrivateAddress } from "../src/webhooks";

// A local receiver standing in for the customer's webhook endpoint. Each
// test decides what it answers.
type Received = { headers: http.IncomingHttpHeaders; body: string };
let received: Received[] = [];
let respondWith = 200;
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.writeHead(respondWith).end();
  });
});
let receiverUrl: string;

let pool: Pool;
let ctx: WorkerContext;
let fx: Fixtures;
const emails: EmailMessage[] = [];
const SECRET = "whsec_test_secret";

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
    email: async (message) => {
      emails.push(message);
      return { messageId: "<abc@mailpit>" };
    },
    webOrigin: "http://fireline.test",
    blockPrivateWebhookTargets: false,
  };
});
afterAll(async () => {
  await Promise.all([ctx.notificationsQueue, ctx.escalationsQueue, ctx.webhooksQueue, ctx.deadLetterQueue].map((q) => q.close()));
  await ctx.redis.quit();
  await pool.end();
  receiver.close();
});
beforeEach(async () => {
  fx = await resetFixtures(pool);
  await ctx.redis.flushdb();
  received = [];
  respondWith = 200;
  emails.length = 0;
});

async function openIncident() {
  const { rows } = await pool.query(
    `INSERT INTO incidents (organization_id, number, service_id, title, severity, next_escalation_at)
     VALUES ($1, 142, $2, 'Checkout API unavailable', 'sev1', now()) RETURNING id`,
    [fx.orgs.acme, fx.services.checkout]
  );
  return rows[0].id as number;
}

async function addEndpoint(events = ["incident.triggered", "incident.escalated"], url = receiverUrl, orgId = fx.orgs.acme) {
  const { rows } = await pool.query(
    `INSERT INTO webhook_endpoints (organization_id, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, url, SECRET, events]
  );
  return rows[0].id as number;
}

const fanOut = (incidentId: number, event: "incident.triggered" | "incident.escalated" = "incident.triggered") =>
  withTransaction(pool, (db) => queueWebhookEvent(db, event, incidentId));

describe("webhook fan-out", () => {
  it("writes one delivery per enabled, subscribed endpoint of the incident's organization", async () => {
    const id = await openIncident();
    const subscribed = await addEndpoint(["incident.triggered"]);
    await addEndpoint(["incident.resolved"]); // not subscribed to triggered
    const disabled = await addEndpoint(["incident.triggered"]);
    await pool.query(`UPDATE webhook_endpoints SET enabled = false WHERE id = $1`, [disabled]);
    await addEndpoint(["incident.triggered"], receiverUrl, fx.orgs.other); // another tenant

    const ids = await fanOut(id);
    expect(ids).toHaveLength(1);
    const { rows } = await pool.query(`SELECT endpoint_id, event, status, payload FROM webhook_deliveries`);
    expect(rows[0]).toMatchObject({ endpoint_id: subscribed, event: "incident.triggered", status: "queued" });
    expect(rows[0].payload).toMatchObject({
      event: "incident.triggered",
      incident: {
        id: "INC-142",
        title: "Checkout API unavailable",
        severity: "critical",
        severityLevel: "sev1",
        status: "triggered",
        service: { name: "Checkout API", slug: "checkout-api" },
        url: "http://localhost:3000/incidents/142",
      },
    });
    expect(rows[0].payload.id).toMatch(/^evt_[0-9A-Z]{26}$/);
  });

  it("sends incident.escalated when a later escalation step pages", async () => {
    const id = await openIncident();
    await addEndpoint(["incident.escalated"]);
    await escalateIncident(ctx, id); // step 1: the first page, not an escalation
    expect(await ctx.webhooksQueue.getJobCounts("waiting")).toMatchObject({ waiting: 0 });
    await pool.query(`UPDATE incidents SET next_escalation_at = now() - interval '1 second'`);
    await escalateIncident(ctx, id); // step 2
    const { rows } = await pool.query(`SELECT event, payload FROM webhook_deliveries`);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.incident.escalationLevel).toBe(2);
    expect(await ctx.webhooksQueue.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
  });
});

describe("deliverWebhook", () => {
  it("POSTs the stored payload with a verifiable HMAC signature", async () => {
    const id = await openIncident();
    await addEndpoint();
    const [deliveryId] = await fanOut(id);

    expect(await deliverWebhook(ctx, deliveryId)).toBe("sent");
    expect(received).toHaveLength(1);
    const [req] = received;
    expect(req.headers["fireline-event"]).toBe("incident.triggered");
    expect(req.headers["fireline-delivery"]).toBe(String(deliveryId));
    expect(req.headers["content-type"]).toBe("application/json");
    expect(verifyWebhookSignature(SECRET, req.body, req.headers["fireline-signature"] as string)).toBe(true);
    expect(verifyWebhookSignature("whsec_wrong", req.body, req.headers["fireline-signature"] as string)).toBe(false);
    expect(JSON.parse(req.body).incident.id).toBe("INC-142");

    const { rows } = await pool.query(`SELECT status, attempts, response_status FROM webhook_deliveries`);
    expect(rows[0]).toEqual({ status: "sent", attempts: 1, response_status: 200 });
    // Redelivery of a finished row is a no-op.
    expect(await deliverWebhook(ctx, deliveryId)).toBe("skipped");
    expect(received).toHaveLength(1);
  });

  it("records non-2xx answers for retry, and fails the row on the last attempt", async () => {
    const id = await openIncident();
    await addEndpoint();
    const [deliveryId] = await fanOut(id);
    respondWith = 503;

    await expect(deliverWebhook(ctx, deliveryId, false)).rejects.toThrow("Receiver answered HTTP 503");
    expect((await pool.query(`SELECT status, attempts, response_status FROM webhook_deliveries`)).rows[0]).toEqual({
      status: "queued",
      attempts: 1,
      response_status: 503,
    });
    await expect(deliverWebhook(ctx, deliveryId, true)).rejects.toThrow();
    expect((await pool.query(`SELECT status FROM webhook_deliveries`)).rows[0].status).toBe("failed");
  });

  it("disables an endpoint that answers 410 Gone, without retrying", async () => {
    const id = await openIncident();
    const endpointId = await addEndpoint();
    const [deliveryId] = await fanOut(id);
    respondWith = 410;
    expect(await deliverWebhook(ctx, deliveryId, false)).toBe("disabled");
    const { rows } = await pool.query(`SELECT enabled, disabled_reason FROM webhook_endpoints WHERE id = $1`, [endpointId]);
    expect(rows[0]).toEqual({ enabled: false, disabled_reason: "Receiver answered 410 Gone; endpoint disabled" });
    expect((await pool.query(`SELECT status FROM webhook_deliveries`)).rows[0].status).toBe("failed");
  });

  it("refuses private network targets when SSRF protection is on", async () => {
    const id = await openIncident();
    await addEndpoint();
    const [deliveryId] = await fanOut(id);
    await expect(deliverWebhook({ ...ctx, blockPrivateWebhookTargets: true }, deliveryId, true)).rejects.toThrow(/private address/);
    expect(received).toHaveLength(0);

    expect(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"].every(isPrivateAddress)).toBe(true);
    expect(["8.8.8.8", "172.32.0.1", "2606:4700::1111"].some(isPrivateAddress)).toBe(false);
  });
});

describe("email pages", () => {
  it("emails the paged responder with a link to the incident and records the message id", async () => {
    const id = await openIncident();
    await escalateIncident(ctx, id);
    const { rows } = await pool.query(`SELECT id, channel FROM notifications`);
    expect(rows[0].channel).toBe("email");
    expect(await deliverNotification(ctx, rows[0].id)).toBe("sent");

    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      to: { name: "Sam", email: "sam@test.dev" },
      subject: "[SEV1 · Critical] New incident: INC-142 Checkout API unavailable (Checkout API)",
    });
    expect(emails[0].text).toContain("http://fireline.test/incidents/142");
    expect(emails[0].html).toContain('href="http://fireline.test/incidents/142"');
    const { rows: after } = await pool.query(`SELECT status, provider_message_id FROM notifications`);
    expect(after[0]).toEqual({ status: "sent", provider_message_id: "<abc@mailpit>" });
  });
});
