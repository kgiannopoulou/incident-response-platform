import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { IngestionStats, percentile } from "../src/lib/ingestion-stats";
import { createTestContext, type TestContext } from "./helpers";

// Alert ingestion under concurrency: many alerts for many incidents at once,
// on more than one service, with retried deliveries mixed in. The invariants
// are the ones a real alert storm needs: one incident per open problem, every
// alert attached to it, one page per incident, no 5xx.
// scripts/load-test.mjs runs the same shape against a running stack and
// reports throughput and latency.

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  // The default per-key limit (120/min) would turn most of the storm into 429s.
  await t.deps.pool.query(`UPDATE api_keys SET rate_limit_per_minute = 100000`);
});

const storm = (service: "checkout" | "auth", problems: number, perProblem: number) =>
  Array.from({ length: problems * perProblem }, (_, i) => ({
    key: TEST_KEYS[service],
    body: { title: `${service} problem ${i % problems}`, severity: "critical", source: "load", deduplicationKey: `${service}-${i % problems}` },
  }));

describe("alert storm", () => {
  it("400 concurrent alerts for 20 problems on two services: 20 incidents, 400 alerts, one page each", async () => {
    const alerts = [...storm("checkout", 10, 20), ...storm("auth", 10, 20)].sort(() => Math.random() - 0.5);
    const responses = await Promise.all(alerts.map((a) => t.alert(a.key, a.body)));

    expect(responses.filter((r) => r.status !== 202).map((r) => r.status)).toEqual([]);
    const decisions = responses.map((r) => r.body.decision);
    expect(decisions.filter((d) => d === "incident_created")).toHaveLength(20);
    expect(decisions.filter((d) => d === "grouped")).toHaveLength(380);

    const { rows } = await t.deps.pool.query(
      `SELECT count(*)::int AS incidents, min(alert_count)::int AS min, max(alert_count)::int AS max, sum(alert_count)::int AS total FROM incidents`
    );
    expect(rows[0]).toEqual({ incidents: 20, min: 20, max: 20, total: 400 });
    const { rows: stored } = await t.deps.pool.query(
      `SELECT (SELECT count(*)::int FROM alerts) AS n, count(*)::int AS links, count(DISTINCT incident_id)::int AS incidents FROM incident_alerts`
    );
    expect(stored[0]).toEqual({ n: 400, links: 400, incidents: 20 });
    // Incident numbers stay dense and unique per organization under the race.
    const { rows: numbers } = await t.deps.pool.query(`SELECT array_agg(number ORDER BY number) AS n FROM incidents`);
    expect(numbers[0].n).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // Exactly one incident-created escalation job per incident whose service
    // has an escalation policy (the fixture's checkout; auth has none).
    const jobs = await t.deps.queues.escalations.getJobs(["waiting", "delayed", "prioritized"]);
    const { rows: paged } = await t.deps.pool.query(
      `SELECT array_agg(i.id ORDER BY i.id) AS ids FROM incidents i JOIN services s ON s.id = i.service_id WHERE s.escalation_policy_id IS NOT NULL`
    );
    expect(paged[0].ids).toHaveLength(10);
    expect(jobs.map((j) => j.data.incidentId).sort((a, b) => a - b)).toEqual(paged[0].ids);
  });

  it("records retried deliveries in the storm once (Idempotency-Key)", async () => {
    const send = (id: number) =>
      request(t.app)
        .post("/api/v1/alerts")
        .set("Authorization", `Bearer ${TEST_KEYS.checkout}`)
        .set("Idempotency-Key", `delivery-${id}`)
        .send({ title: "Payment provider timeouts", severity: "high", deduplicationKey: "psp-timeouts", metadata: { delivery: id } });
    // 50 distinct deliveries, each sent 4 times concurrently.
    const responses = await Promise.all(Array.from({ length: 200 }, (_, i) => send(i % 50)));
    expect(responses.map((r) => r.status).filter((s) => s !== 202)).toEqual([]);

    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS alerts FROM alerts`);
    expect(rows[0].alerts).toBe(50);
    const { rows: incidents } = await t.deps.pool.query(`SELECT count(*)::int AS n, max(alert_count)::int AS alerts FROM incidents`);
    expect(incidents[0]).toEqual({ n: 1, alerts: 50 });
    // Every copy of a delivery got the same alert id back.
    const byDelivery = new Map<number, Set<string>>();
    responses.forEach((r, i) => byDelivery.set(i % 50, (byDelivery.get(i % 50) ?? new Set()).add(r.body.id)));
    expect([...byDelivery.values()].every((ids) => ids.size === 1)).toBe(true);
  });

  it("measures every request, so /admin/ingestion reports the storm", async () => {
    const before = t.deps.ingestionStats!.summary();
    await Promise.all(storm("checkout", 5, 10).map((a) => t.alert(a.key, a.body)));
    await t.alert("ir_live_not_a_key", { title: "x", severity: "critical" }); // rejected requests are measured too

    const admin = await t.as("alex");
    const res = await request(t.app).get("/api/v1/admin/ingestion?window=60").set(admin);
    expect(res.status).toBe(200);
    // The stats are per process, so other tests' alerts are in there too.
    expect(res.body.sinceStart.count - before.sinceStart.count).toBe(51);
    expect(res.body.decisions.incident_created - (before.decisions.incident_created ?? 0)).toBe(5);
    expect(res.body.decisions.grouped - (before.decisions.grouped ?? 0)).toBe(45);
    expect(res.body.latencyMs.p50).toBeGreaterThan(0);
    expect(res.body.latencyMs.p99).toBeGreaterThanOrEqual(res.body.latencyMs.p50);

    const responder = await t.as("sam");
    expect((await request(t.app).get("/api/v1/admin/ingestion").set(responder)).status).toBe(403);
    expect((await request(t.app).get("/api/v1/admin/ingestion?window=5").set(admin)).status).toBe(400);
  });
});

describe("IngestionStats", () => {
  it("computes nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(values, 50), percentile(values, 95), percentile(values, 99), percentile(values, 100)]).toEqual([50, 95, 99, 100]);
    expect(percentile([], 50)).toBe(0);
  });

  it("summarises only the window, counts 5xx, and keeps memory bounded", () => {
    let now = 1_000_000;
    const stats = new IngestionStats(100, () => now);
    stats.record(500, 202, "grouped"); // falls out of the window
    now += 400_000;
    for (let i = 1; i <= 150; i++) {
      stats.record(i, i % 50 === 0 ? 503 : 202, "grouped");
      now += 100;
    }
    const s = stats.summary(300);
    expect(s.count).toBe(100); // capacity: samples 51-150
    expect(s.sinceStart).toMatchObject({ count: 151, errors: 3 });
    expect(s.errors).toBe(2); // 100 and 150; 50 was overwritten
    expect(s.latencyMs).toEqual({ p50: 100, p95: 145, p99: 149, max: 150 });
    expect(s.perSecond).toBe(10);
  });

  it("answers null latency when nothing arrived", () => {
    expect(new IngestionStats().summary()).toMatchObject({ count: 0, latencyMs: null, perSecond: 0 });
  });
});
