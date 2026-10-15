import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IncidentApiError, IncidentClient } from "@incident-platform/sdk";
import { TEST_KEYS } from "@irp/database/testing";
import { createTestContext, type TestContext } from "./helpers";

// Application ──SDK──► Alert API ──► Incident engine, over real HTTP: the
// published client against the real app on a random port.
let t: TestContext;
let server: Server;
let baseUrl: string;
beforeAll(async () => {
  t = await createTestContext();
  server = t.app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await t.close();
});
beforeEach(() => t.reset());

const incidentsFor = (apiKey: string) => new IncidentClient({ apiKey, baseUrl, baseDelayMs: 1 });

describe("@incident-platform/sdk against the API", () => {
  it("opens one incident and groups repeats, exactly like the plan's example", async () => {
    const incidents = incidentsFor(TEST_KEYS.checkout);
    const first = await incidents.alert({ severity: "critical", title: "Database connection failure", deduplicationKey: "db-connection" });
    const second = await incidents.alert({ severity: "critical", title: "Database connection failure", deduplicationKey: "db-connection" });
    expect(first).toMatchObject({ decision: "incident_created", service: "checkout-api", incident: { number: 1, severity: "sev1" } });
    expect(second).toMatchObject({ decision: "grouped", incident: { number: 1, alertCount: 2 } });
    const { rows } = await t.deps.pool.query(`SELECT source, metadata FROM alerts ORDER BY id LIMIT 1`);
    expect(rows[0]).toEqual({ source: "sdk", metadata: {} });
  });

  it("groups the same exception into one incident and clears it with resolve", async () => {
    const incidents = incidentsFor(TEST_KEYS.checkout);
    const charge = (amount: number) => {
      throw new Error(`Card processor timeout after ${amount}ms`);
    };
    for (const amount of [3000, 3100, 2900]) {
      try {
        charge(amount);
      } catch (err) {
        await incidents.captureException(err, { severity: "critical" });
      }
    }
    const { rows } = await t.deps.pool.query(`SELECT number, alert_count, status FROM incidents`);
    expect(rows).toEqual([{ number: 1, alert_count: 3, status: "triggered" }]);

    const { rows: alert } = await t.deps.pool.query(`SELECT dedup_key FROM alerts LIMIT 1`);
    await incidents.resolve(alert[0].dedup_key);
    // Checkout auto-resolves once its alerts are cleared.
    const detail = await request(t.app).get("/api/v1/incidents/1").set(await t.as("sam"));
    expect(detail.body.incident.status).toBe("resolved");
  });

  it("monitors a job end to end", async () => {
    const incidents = incidentsFor(TEST_KEYS.checkout);
    await expect(incidents.monitor("nightly-billing", () => Promise.reject(new Error("ledger locked")), { severity: "critical" })).rejects.toThrow();
    expect((await t.deps.pool.query(`SELECT title, status FROM incidents`)).rows).toEqual([{ title: "nightly-billing failed: ledger locked", status: "triggered" }]);
    await incidents.monitor("nightly-billing", () => "ok");
    expect((await t.deps.pool.query(`SELECT status FROM incidents`)).rows).toEqual([{ status: "resolved" }]);
  });

  it("surfaces the API's errors: bad key (no retry) and a service the key doesn't own", async () => {
    await expect(incidentsFor("ir_live_nope").alert({ severity: "high", title: "x" })).rejects.toMatchObject({ status: 401, message: "Invalid API key" });
    const wrongService = incidentsFor(TEST_KEYS.checkout).alert({ severity: "high", title: "x", service: "auth-service" });
    await expect(wrongService).rejects.toBeInstanceOf(IncidentApiError);
    await expect(wrongService).rejects.toMatchObject({ status: 403 });
  });
});
