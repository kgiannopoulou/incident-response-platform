import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const api = () => request(t.app);
const critical = { title: "Checkout API unavailable", severity: "critical", source: "probe", deduplicationKey: "checkout" };

async function createEndpoint(body: Record<string, unknown> = {}) {
  const res = await api()
    .post("/api/v1/webhooks")
    .set(await t.as("alex"))
    .send({ url: "https://hooks.example.com/fireline", description: "Ops bot", ...body });
  expect(res.status).toBe(201);
  return res.body as { endpoint: { id: number }; secret: string };
}

const deliveries = async () =>
  (await t.deps.pool.query(`SELECT event, status, payload FROM webhook_deliveries ORDER BY id`)).rows;

describe("webhook endpoints", () => {
  it("returns the signing secret once and never lists it", async () => {
    expect((await api().post("/api/v1/webhooks").set(await t.as("sam")).send({ url: "https://x.example" })).status).toBe(403);
    const { endpoint, secret } = await createEndpoint();
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint).toMatchObject({ url: "https://hooks.example.com/fireline", enabled: true, events: expect.any(Array) });

    const list = await api().get("/api/v1/webhooks").set(await t.as("alex"));
    expect(list.body.endpoints).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(secret);

    const rotated = await api().post(`/api/v1/webhooks/${endpoint.id}/rotate-secret`).set(await t.as("alex"));
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(secret);
  });

  it("rejects non-http URLs and hides other tenants' endpoints", async () => {
    const bad = await api().post("/api/v1/webhooks").set(await t.as("alex")).send({ url: "file:///etc/passwd" });
    expect(bad.status).toBe(400);
    const { endpoint } = await createEndpoint();
    const eve = await t.as("eve");
    expect((await api().get("/api/v1/webhooks").set(eve)).body.endpoints).toEqual([]);
    expect((await api().patch(`/api/v1/webhooks/${endpoint.id}`).set(eve).send({ enabled: false })).status).toBe(404);
    expect((await api().delete(`/api/v1/webhooks/${endpoint.id}`).set(eve)).status).toBe(404);
  });

  it("queues a signed ping for 'Send test' and lists it under deliveries", async () => {
    const { endpoint } = await createEndpoint();
    const res = await api().post(`/api/v1/webhooks/${endpoint.id}/test`).set(await t.as("alex"));
    expect(res.status).toBe(202);
    expect(await t.deps.queues.webhooks.getJob(`webhook-${res.body.delivery.id}`)).toBeTruthy();
    const list = await api().get(`/api/v1/webhooks/${endpoint.id}/deliveries`).set(await t.as("alex"));
    expect(list.body.deliveries).toEqual([expect.objectContaining({ event: "ping", status: "queued" })]);
  });

  it("redelivers a finished delivery with the same payload", async () => {
    const { endpoint } = await createEndpoint();
    const ping = await api().post(`/api/v1/webhooks/${endpoint.id}/test`).set(await t.as("alex"));
    const id = ping.body.delivery.id;
    expect((await api().post(`/api/v1/webhooks/deliveries/${id}/redeliver`).set(await t.as("alex"))).status).toBe(409); // still queued
    await t.deps.pool.query(`UPDATE webhook_deliveries SET status = 'failed', attempts = 5, last_error = 'HTTP 500'`);
    const before = (await deliveries())[0].payload;
    expect((await api().post(`/api/v1/webhooks/deliveries/${id}/redeliver`).set(await t.as("alex"))).status).toBe(202);
    const [after] = await deliveries();
    expect(after).toMatchObject({ status: "queued" });
    expect(after.payload.id).toBe(before.id);
  });
});

describe("incident events", () => {
  it("emits triggered, acknowledged and resolved to subscribed endpoints, in the same transaction", async () => {
    await createEndpoint();
    await createEndpoint({ url: "https://only-resolved.example.com", events: ["incident.resolved"] });
    await t.alert(TEST_KEYS.checkout, critical);
    await t.alert(TEST_KEYS.checkout, critical); // grouped into the same incident: no new event
    const sam = await t.as("sam");
    await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "investigating" }).expect(200); // not a webhook event
    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);

    const rows = await deliveries();
    expect(rows.map((r) => r.event)).toEqual([
      "incident.triggered",
      "incident.acknowledged",
      "incident.resolved",
      "incident.resolved",
    ]);
    expect(rows[0].payload.incident).toMatchObject({ id: "INC-1", severity: "critical", title: "Checkout API unavailable" });
    expect(rows[1].payload).toMatchObject({ actor: "Sam", incident: { status: "acknowledged" } });
    expect(await t.deps.queues.webhooks.getJobCounts("waiting")).toMatchObject({ waiting: 4 });
  });

  it("emits incident.escalated for a manual escalation, and nothing for disabled endpoints", async () => {
    const { endpoint } = await createEndpoint();
    await t.alert(TEST_KEYS.checkout, critical);
    await api().post("/api/v1/incidents/1/escalate").set(await t.as("sam")).expect(200);
    await api().patch(`/api/v1/webhooks/${endpoint.id}`).set(await t.as("alex")).send({ enabled: false }).expect(200);
    await api().post("/api/v1/incidents/1/escalate").set(await t.as("sam")).expect(200);
    expect((await deliveries()).map((r) => r.event)).toEqual(["incident.triggered", "incident.escalated"]);
  });
});
