import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRODUCTION_INCIDENT } from "@irp/shared";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const api = () => request(t.app);

// The test app plays every step at once (timeScale 0); wait for the last one.
async function finishedRun(headers: Record<string, string>) {
  for (let i = 0; i < 100; i++) {
    const { body } = await api().get("/api/v1/demo").set(headers);
    if (body.run?.done) return body.run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("simulation did not finish");
}

describe("Simulate production incident", () => {
  it("plays the scenario through the real ingestion pipeline", async () => {
    const alex = await t.as("alex");
    const { body } = await api().post("/api/v1/demo/simulate").set(alex).send({}).expect(202);
    expect(body.run).toMatchObject({ scenario: "checkout-outage", startedBy: "Alex", speed: 1, total: PRODUCTION_INCIDENT.steps.length });

    const run = await finishedRun(alex);
    // The test fixtures have no latency rule and no postgres-primary service.
    expect(run.results.map((r: { decision: string }) => r.decision)).toEqual([
      "recorded", // CPU warning
      "recorded", // latency warning
      "incident_created", // 5xx 12% (HIGH → SEV2)
      "grouped", // 5xx 38% (CRITICAL → raised to SEV1)
      'skipped (no service "postgres-primary")',
      "grouped",
    ]);

    const { rows: incidents } = await t.deps.pool.query(`SELECT number, severity, alert_count, status FROM incidents`);
    expect(incidents).toEqual([{ number: 1, severity: "sev1", alert_count: 3, status: "triggered" }]);
    const { rows: alerts } = await t.deps.pool.query(`SELECT metadata FROM alerts`);
    expect(alerts).toHaveLength(5);
    expect(alerts.every((a) => a.metadata.simulated === true && a.metadata.demoRun === run.runId)).toBe(true);

    // Paging starts like for any real incident.
    expect(await t.deps.queues.escalations.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
    const { rows: audit } = await t.deps.pool.query(`SELECT action, details FROM audit_log WHERE action = 'demo.simulate'`);
    expect(audit[0].details).toMatchObject({ runId: run.runId, scenario: "checkout-outage" });
  });

  it("runs one simulation at a time per organization", async () => {
    const alex = await t.as("alex");
    await t.deps.redis.set("irp:demo:org:" + t.fx.orgs.acme, JSON.stringify({ runId: "busy", done: false }), "EX", 60);
    const res = await api().post("/api/v1/demo/simulate").set(alex).send({});
    expect(res.status).toBe(409);
    // Another organization is unaffected, and can't see Acme's run.
    const eve = await t.as("eve");
    expect((await api().get("/api/v1/demo").set(eve)).body.run).toBeNull();
    await api().post("/api/v1/demo/simulate").set(eve).send({ speed: 5 }).expect(202);
  });

  it("is admin-only, validates the speed and can be disabled", async () => {
    expect((await api().post("/api/v1/demo/simulate").set(await t.as("sam")).send({})).status).toBe(403);
    const alex = await t.as("alex");
    expect((await api().post("/api/v1/demo/simulate").set(alex).send({ speed: 3 })).status).toBe(400);
    const { body } = await api().get("/api/v1/demo").set(alex).expect(200);
    expect(body).toMatchObject({ enabled: true, scenario: { id: "checkout-outage", steps: expect.any(Array) } });
  });
});
