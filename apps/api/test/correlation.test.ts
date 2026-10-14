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

const errors = {
  service: "checkout-api",
  severity: "critical",
  title: "Checkout API elevated error rate",
  source: "prometheus",
  deduplicationKey: "checkout-errors",
};

describe("alert correlation (deduplicationKey)", () => {
  it("turns four alerts for the same problem into one incident with four alerts", async () => {
    const responses = [];
    for (const errorRate of [12, 19, 27, 38]) {
      responses.push(await t.alert(TEST_KEYS.checkout, { ...errors, metadata: { errorRate } }));
    }
    expect(responses.map((r) => r.body.decision)).toEqual(["incident_created", "grouped", "grouped", "grouped"]);
    expect(responses[3].body.incident).toMatchObject({ number: 1, status: "triggered", severity: "sev1", alertCount: 4 });
    expect(responses[3].body.reason).toBe("Grouped into open incident (4 alerts)");

    const { rows } = await t.deps.pool.query(
      `SELECT count(*)::int AS incidents, max(alert_count) AS alerts,
              (SELECT count(*)::int FROM incident_alerts) AS links,
              (SELECT count(*)::int FROM timeline_events WHERE event_type = 'INCIDENT_CREATED') AS opened
       FROM incidents`
    );
    expect(rows[0]).toEqual({ incidents: 1, alerts: 4, links: 4, opened: 1 });

    const detail = await request(t.app).get("/api/v1/incidents/1").set(await t.as("sam"));
    expect(detail.body.alerts).toHaveLength(4);
    expect(detail.body.alerts.map((a: { metadata: { errorRate: number } }) => a.metadata.errorRate)).toEqual([12, 19, 27, 38]);
    expect(detail.body.timeline.filter((e: { event_type: string }) => e.event_type === "ALERT_ATTACHED")).toHaveLength(3);
    expect(detail.body.incident.last_alert_at).toBe(detail.body.alerts[3].received_at);
  });

  it("keeps different deduplication keys and different services apart", async () => {
    await t.alert(TEST_KEYS.checkout, errors);
    const latency = await t.alert(TEST_KEYS.checkout, { ...errors, title: "Checkout p99 latency", deduplicationKey: "checkout-latency" });
    const auth = await t.alert(TEST_KEYS.auth, { ...errors, service: "auth-service" });
    expect(latency.body).toMatchObject({ decision: "incident_created", incident: { number: 2 } });
    expect(auth.body).toMatchObject({ decision: "incident_created", incident: { number: 3 } });
  });

  it("raises the incident severity when a more severe alert joins it", async () => {
    const opened = await t.alert(TEST_KEYS.checkout, { ...errors, severity: "high" });
    expect(opened.body.incident.severity).toBe("sev2");

    const worse = await t.alert(TEST_KEYS.checkout, errors);
    expect(worse.body.incident).toMatchObject({ severity: "sev1", alertCount: 2 });

    const { rows } = await t.deps.pool.query(
      `SELECT message, actor_id FROM timeline_events WHERE event_type = 'SEVERITY_CHANGED'`
    );
    expect(rows).toEqual([{ message: "Severity changed from SEV2 to SEV1 (CRITICAL alert grouped)", actor_id: null }]);
  });

  it("never lowers severity automatically, and respects a responder's downgrade", async () => {
    await t.alert(TEST_KEYS.checkout, errors);
    const sam = await t.as("sam");
    await request(t.app).post("/api/v1/incidents/1/severity").set(sam).send({ severity: "sev3" }).expect(200);

    // Repeats at a severity already seen are not new information.
    const repeat = await t.alert(TEST_KEYS.checkout, errors);
    const milder = await t.alert(TEST_KEYS.checkout, { ...errors, severity: "warning" });
    expect(repeat.body.incident.severity).toBe("sev3");
    expect(milder.body.incident).toMatchObject({ severity: "sev3", alertCount: 3 });
  });

  it("correlates alerts without a deduplicationKey by service, source and normalized title", async () => {
    const base = { severity: "critical", source: "probe" };
    await t.alert(TEST_KEYS.checkout, { ...base, title: "p99 latency 2300ms" });
    const again = await t.alert(TEST_KEYS.checkout, { ...base, title: "p99 latency 2410ms" });
    expect(again.body).toMatchObject({ decision: "grouped", incident: { number: 1, alertCount: 2 } });
  });

  it("starts a fresh incident for the key once the previous one is resolved", async () => {
    await t.alert(TEST_KEYS.checkout, errors);
    const sam = await t.as("sam");
    await request(t.app).post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);

    const next = await t.alert(TEST_KEYS.checkout, errors);
    expect(next.body).toMatchObject({ decision: "incident_created", incident: { number: 2, alertCount: 1 } });
    const { rows } = await t.deps.pool.query(`SELECT number, alert_count FROM incidents ORDER BY number`);
    expect(rows).toEqual([
      { number: 1, alert_count: 1 },
      { number: 2, alert_count: 1 },
    ]);
  });
});
