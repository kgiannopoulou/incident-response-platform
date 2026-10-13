import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const critical = {
  summary: "Checkout 5xx rate above 5% (currently 23%)",
  severity: "critical",
  source: "prometheus:checkout-5xx",
};

describe("POST /api/v1/alerts", () => {
  it("rejects missing or unknown integration keys", async () => {
    expect((await t.alert("", critical)).status).toBe(401);
    expect((await t.alert("nope", critical)).status).toBe(401);
  });

  it("validates the payload", async () => {
    const res = await t.alert(TEST_KEYS.checkout, { severity: "apocalyptic" });
    expect(res.status).toBe(400);
  });

  it("opens an incident for a critical alert and marks the service as an outage", async () => {
    const res = await t.alert(TEST_KEYS.checkout, critical);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ decision: "incident_created", incident: { number: 1, status: "triggered" } });

    const { rows } = await t.deps.pool.query(
      `SELECT i.severity, i.alert_count, i.next_escalation_at IS NOT NULL AS escalating, s.status AS service_status
       FROM incidents i JOIN services s ON s.id = i.service_id`
    );
    expect(rows).toEqual([{ severity: "sev1", alert_count: 1, escalating: true, service_status: "outage" }]);

    // Escalation job enqueued after commit.
    expect(await t.deps.queues.escalations.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
  });

  it("groups repeats of the same alert (numbers masked) into the open incident", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const res = await t.alert(TEST_KEYS.checkout, { ...critical, summary: "Checkout 5xx rate above 5% (currently 31%)" });
    expect(res.body).toMatchObject({ decision: "grouped", incident: { number: 1 } });

    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n, max(alert_count) AS alerts FROM incidents`);
    expect(rows[0]).toEqual({ n: 1, alerts: 2 });
  });

  it("opens exactly one incident when the same alert arrives concurrently", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => t.alert(TEST_KEYS.checkout, critical)));
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(results.filter((r) => r.body.decision === "incident_created")).toHaveLength(1);

    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n, max(alert_count) AS alerts FROM incidents`);
    expect(rows[0]).toEqual({ n: 1, alerts: 10 });
  });

  it("records warnings without paging and suppresses rule matches", async () => {
    const warning = await t.alert(TEST_KEYS.checkout, { summary: "Disk 81% full", severity: "warning", source: "node" });
    expect(warning.body.decision).toBe("recorded");
    const staging = await t.alert(TEST_KEYS.checkout, { ...critical, source: "staging-probe" });
    expect(staging.body).toMatchObject({ decision: "suppressed", reason: 'Suppressed by rule "Ignore staging"' });

    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n FROM incidents`);
    expect(rows[0].n).toBe(0);
  });

  it("does not page while the service is in maintenance", async () => {
    const admin = await t.as("alex");
    await (await import("supertest")).default(t.app)
      .patch(`/api/v1/services/${t.fx.services.checkout}`)
      .set(admin)
      .send({ maintenance: true })
      .expect(200);
    const res = await t.alert(TEST_KEYS.checkout, critical);
    expect(res.body.decision).toBe("maintenance");
  });

  it("auto-resolves the incident when the monitoring tool clears every alert", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const res = await t.alert(TEST_KEYS.checkout, { ...critical, action: "resolve" });
    expect(res.body).toMatchObject({ decision: "resolved", incident: { number: 1, status: "resolved" } });

    const { rows } = await t.deps.pool.query(
      `SELECT i.status, s.status AS service_status, (SELECT count(*)::int FROM postmortems) AS postmortems
       FROM incidents i JOIN services s ON s.id = i.service_id`
    );
    expect(rows[0]).toEqual({ status: "resolved", service_status: "operational", postmortems: 1 });
  });

  it("keeps the incident open on services without auto-resolve", async () => {
    await t.alert(TEST_KEYS.auth, critical);
    const res = await t.alert(TEST_KEYS.auth, { ...critical, action: "resolve" });
    expect(res.body).toMatchObject({ decision: "resolved", incident: { status: "triggered" } });
  });

  it("starts a new incident for the same alert once the previous one is resolved", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    await t.alert(TEST_KEYS.checkout, { ...critical, action: "resolve" });
    const res = await t.alert(TEST_KEYS.checkout, critical);
    expect(res.body).toMatchObject({ decision: "incident_created", incident: { number: 2 } });
  });
});
