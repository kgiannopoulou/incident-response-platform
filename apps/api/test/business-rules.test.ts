import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { INCIDENT_STATUSES, INCIDENT_TRANSITIONS, type IncidentStatus } from "@irp/shared";
import { createTestContext, type TestContext } from "./helpers";

// Phase 20: the platform's core business rules, end to end over HTTP.

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const api = () => request(t.app);
const alert = (n: number) => ({
  service: "checkout-api",
  severity: "critical",
  title: "Checkout error rate exceeded threshold",
  description: `Error rate reached ${n % 60}%`,
  source: "prometheus",
  deduplicationKey: "checkout-errors",
  metadata: { sample: n },
});

async function counts() {
  const { rows } = await t.deps.pool.query(`
    SELECT (SELECT count(*)::int FROM incidents) AS incidents,
           (SELECT max(alert_count) FROM incidents) AS alert_count,
           (SELECT count(*)::int FROM incident_alerts) AS attached,
           (SELECT count(*)::int FROM alerts) AS alerts,
           (SELECT count(*)::int FROM timeline_events WHERE event_type = 'INCIDENT_CREATED') AS created_events,
           (SELECT count(*)::int FROM timeline_events WHERE event_type = 'ALERT_ATTACHED') AS attached_events`);
  return rows[0];
}

describe("deduplication: 100 alerts with the same key", () => {
  it("sent one after another → 1 incident with 100 attached alerts", async () => {
    const decisions: string[] = [];
    for (let n = 0; n < 100; n++) {
      const res = await t.alert(TEST_KEYS.checkout, alert(n)).expect(202);
      decisions.push(res.body.decision);
    }
    expect(decisions[0]).toBe("incident_created");
    expect(decisions.slice(1).every((d) => d === "grouped")).toBe(true);
    expect(await counts()).toEqual({ incidents: 1, alert_count: 100, attached: 100, alerts: 100, created_events: 1, attached_events: 99 });
  });

  it("sent all at once → still 1 incident with 100 attached alerts, and one page", async () => {
    const responses = await Promise.all(Array.from({ length: 100 }, (_, n) => t.alert(TEST_KEYS.checkout, alert(n))));
    expect(responses.every((r) => r.status === 202)).toBe(true);
    const decisions = responses.map((r) => r.body.decision);
    expect(decisions.filter((d) => d === "incident_created")).toHaveLength(1);
    expect(decisions.filter((d) => d === "grouped")).toHaveLength(99);
    expect(new Set(responses.map((r) => r.body.incident.number))).toEqual(new Set([1]));
    expect(await counts()).toEqual({ incidents: 1, alert_count: 100, attached: 100, alerts: 100, created_events: 1, attached_events: 99 });

    // Only the incident's creation queued an escalation (which pages step 1).
    expect(await t.deps.queues.escalations.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
  });

  it("a different key, or the same key after resolution, opens a new incident", async () => {
    await t.alert(TEST_KEYS.checkout, alert(1)).expect(202);
    await t.alert(TEST_KEYS.checkout, { ...alert(2), deduplicationKey: "checkout-latency" }).expect(202);
    await api().post("/api/v1/incidents/1/status").set(await t.as("sam")).send({ status: "resolved" }).expect(200);
    const again = await t.alert(TEST_KEYS.checkout, alert(3)).expect(202);
    expect(again.body).toMatchObject({ decision: "incident_created", incident: { number: 3 } });
  });
});

describe("incident state machine, as the plan's table", () => {
  // From → to, expected result.
  const TABLE: [IncidentStatus, IncidentStatus, boolean][] = [
    ["triggered", "acknowledged", true],
    ["acknowledged", "investigating", true],
    ["investigating", "resolved", true],
    ["resolved", "investigating", false],
  ];

  // Walks a fresh incident into `from` along the shortest allowed path.
  async function incidentIn(from: IncidentStatus, headers: Record<string, string>) {
    await t.alert(TEST_KEYS.checkout, alert(1)).expect(202);
    const path: Record<IncidentStatus, IncidentStatus[]> = {
      triggered: [],
      acknowledged: ["acknowledged"],
      investigating: ["acknowledged", "investigating"],
      mitigated: ["acknowledged", "investigating", "mitigated"],
      resolved: ["resolved"],
    };
    for (const status of path[from]) await api().post("/api/v1/incidents/1/status").set(headers).send({ status }).expect(200);
  }

  it.each(TABLE)("%s → %s %s", async (from, to, allowed) => {
    const sam = await t.as("sam");
    await incidentIn(from, sam);
    const res = await api().post("/api/v1/incidents/1/status").set(sam).send({ status: to });
    if (allowed) {
      expect(res.status).toBe(200);
      expect(res.body.incident.status).toBe(to);
    } else {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ from, to, allowed: [] });
      const { rows } = await t.deps.pool.query(`SELECT status FROM incidents`);
      expect(rows[0].status).toBe(from); // nothing changed
    }
  });

  it("checks every one of the 25 (from, to) pairs over HTTP", async () => {
    const sam = await t.as("sam");
    const results: string[] = [];
    for (const from of INCIDENT_STATUSES) {
      for (const to of INCIDENT_STATUSES) {
        if (from === to) continue;
        await t.reset();
        const headers = await t.as("sam");
        await incidentIn(from, headers);
        const res = await api().post("/api/v1/incidents/1/status").set(headers).send({ status: to });
        results.push(`${from}→${to}:${res.status}`);
        expect(res.status).toBe(INCIDENT_TRANSITIONS[from].includes(to) ? 200 : 409);
      }
    }
    expect(results).toHaveLength(20);
    expect(results.filter((r) => r.endsWith(":200"))).toHaveLength(7);
    void sam;
  });
});
