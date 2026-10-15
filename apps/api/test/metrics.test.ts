import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

let number = 0;
// Inserts an incident that triggered `daysAgo` days ago, acknowledged and
// resolved after the given numbers of minutes (null = not yet).
async function incident(opts: {
  daysAgo: number;
  severity?: string;
  ackMin?: number | null;
  resolveMin?: number | null;
  service?: "checkout" | "auth" | "other";
  ackTimedOut?: boolean;
}) {
  const { severity = "sev2", ackMin = null, resolveMin = null, service = "checkout", ackTimedOut = false } = opts;
  const org = service === "other" ? t.fx.orgs.other : t.fx.orgs.acme;
  await t.deps.pool.query(
    `INSERT INTO incidents (organization_id, number, service_id, title, severity, status, triggered_at, acknowledged_at, resolved_at, ack_timed_out_at)
     VALUES ($1, $2, $3, 'x', $4, $5,
             now() - make_interval(days => $6::int),
             now() - make_interval(days => $6::int) + make_interval(mins => $7::int),
             now() - make_interval(days => $6::int) + make_interval(mins => $8::int),
             CASE WHEN $9 THEN now() - make_interval(days => $6::int) + interval '2 minutes' END)`,
    [org, ++number, t.fx.services[service], severity, resolveMin !== null ? "resolved" : ackMin !== null ? "acknowledged" : "triggered", opts.daysAgo, ackMin, resolveMin, ackTimedOut]
  );
}

const metrics = async (days?: number) =>
  (await request(t.app).get(`/api/v1/metrics${days ? `?days=${days}` : ""}`).set(await t.as("sam")).expect(200)).body;

describe("GET /metrics", () => {
  beforeEach(() => {
    number = 0;
  });

  it("computes MTTA and MTTR over the window, with medians and p90", async () => {
    await incident({ daysAgo: 1, severity: "sev1", ackMin: 2, resolveMin: 30 });
    await incident({ daysAgo: 2, ackMin: 4, resolveMin: 50 });
    await incident({ daysAgo: 3, ackMin: 6, resolveMin: 100 });
    await incident({ daysAgo: 4, ackMin: 8 }); // still open: counts for MTTA, not MTTR
    const m = await metrics();
    expect(m.window).toEqual({ days: 30 });
    expect(m.summary).toMatchObject({
      incidents: 4,
      sev1: 1,
      still_open: 1,
      mtta_seconds: 5 * 60, // (2+4+6+8)/4 min
      mttr_seconds: 60 * 60, // (30+50+100)/3 min
      tta_p50_seconds: 5 * 60,
      ttr_p50_seconds: 50 * 60,
    });
    expect(m.summary.ttr_p90_seconds).toBe(90 * 60); // interpolated between 50 and 100 min
  });

  it("compares with the previous window of the same length", async () => {
    await incident({ daysAgo: 2, ackMin: 2, resolveMin: 20 });
    await incident({ daysAgo: 10, ackMin: 10, resolveMin: 90 }); // previous 7 days
    await incident({ daysAgo: 12, ackMin: 6, resolveMin: 30 });
    await incident({ daysAgo: 20, ackMin: 1, resolveMin: 1 }); // older than both windows
    const m = await metrics(7);
    expect(m.summary).toMatchObject({ incidents: 1, mtta_seconds: 120 });
    expect(m.previous).toMatchObject({ incidents: 2, mtta_seconds: 8 * 60, mttr_seconds: 60 * 60 });
  });

  it("breaks incidents down by severity (all four, zeros included) and by service", async () => {
    await incident({ daysAgo: 1, severity: "sev1", ackMin: 1, resolveMin: 10, ackTimedOut: true });
    await incident({ daysAgo: 1, severity: "sev1", ackMin: 3, resolveMin: 20 });
    await incident({ daysAgo: 2, severity: "sev3", service: "auth" });
    const m = await metrics();
    expect(m.bySeverity.map((s: { severity: string; incidents: number }) => [s.severity, s.incidents])).toEqual([
      ["sev1", 2],
      ["sev2", 0],
      ["sev3", 1],
      ["sev4", 0],
    ]);
    expect(m.bySeverity[0]).toMatchObject({ mtta_seconds: 120, mttr_seconds: 15 * 60, ack_timeouts: 1 });
    expect(m.bySeverity[1]).toMatchObject({ mtta_seconds: null, mttr_seconds: null });
    expect(m.byService.map((s: { name: string; incidents: number; open_incidents: number }) => [s.name, s.incidents, s.open_incidents])).toEqual([
      ["Checkout API", 2, 0],
      ["Auth Service", 1, 1],
    ]);
  });

  it("returns one bucket per day, zeros included, split by severity", async () => {
    await incident({ daysAgo: 0, severity: "sev1" });
    await incident({ daysAgo: 0, severity: "sev2" });
    const m = await metrics(7);
    expect(m.daily).toHaveLength(7);
    expect(m.daily.at(-1)).toMatchObject({ date: new Date().toISOString().slice(0, 10), sev1: 1, sev2: 1, sev3: 0, sev4: 0 });
    expect(m.daily.slice(0, 6).every((d: { sev1: number; sev2: number }) => d.sev1 + d.sev2 === 0)).toBe(true);
    expect((await metrics(90)).daily).toHaveLength(90);
  });

  it("lists active incidents worst first, then oldest", async () => {
    await incident({ daysAgo: 1, severity: "sev2" });
    await incident({ daysAgo: 2, severity: "sev1", ackMin: 3 });
    await incident({ daysAgo: 0, severity: "sev1" });
    await incident({ daysAgo: 0, severity: "sev1", ackMin: 1, resolveMin: 5 }); // resolved: not active
    const m = await metrics();
    expect(m.active.map((i: { number: number }) => i.number)).toEqual([2, 3, 1]);
    expect(m.active[0]).toMatchObject({ severity: "sev1", status: "acknowledged", service_name: "Checkout API" });
  });

  it("only counts the caller's organization", async () => {
    await incident({ daysAgo: 1, service: "other", ackMin: 1, resolveMin: 2 });
    const m = await metrics();
    expect(m.summary.incidents).toBe(0);
    expect(m.active).toEqual([]);
    expect(m.byService.map((s: { name: string }) => s.name)).not.toContain("Other API");
  });

  it("accepts 7, 30 or 90 days and requires a session", async () => {
    const sam = await t.as("sam");
    expect((await request(t.app).get("/api/v1/metrics?days=14").set(sam)).status).toBe(400);
    expect((await request(t.app).get("/api/v1/metrics?days=abc").set(sam)).status).toBe(400);
    expect((await request(t.app).get("/api/v1/metrics")).status).toBe(401);
  });
});
