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

const critical = { summary: "Checkout down", severity: "critical", source: "probe" };
const api = () => request(t.app);

describe("auth", () => {
  it("logs in with valid credentials only", async () => {
    const bad = await api().post("/api/v1/auth/login").send({ email: "alex@test.dev", password: "wrong" });
    expect(bad.status).toBe(401);
    const me = await api().get("/api/v1/auth/me").set(await t.as("alex"));
    expect(me.body.user).toMatchObject({ name: "Alex", role: "admin", organizationName: "Acme" });
  });

  it("requires a session for incident routes", async () => {
    expect((await api().get("/api/v1/incidents")).status).toBe(401);
  });
});

describe("incident lifecycle", () => {
  it("acknowledge -> investigate -> resolve -> postmortem, with timeline and audit trail", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const sam = await t.as("sam");

    const ack = await api().post("/api/v1/incidents/1/acknowledge").set(sam);
    expect(ack.status).toBe(200);
    expect(ack.body.incident).toMatchObject({ status: "acknowledged", next_escalation_at: null, commander_id: t.fx.users.sam });

    // A second acknowledge is a state-machine violation, not a silent no-op.
    expect((await api().post("/api/v1/incidents/1/acknowledge").set(sam)).status).toBe(409);

    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "investigating" }).expect(200);
    await api().post("/api/v1/incidents/1/notes").set(sam).send({ message: "Rolled back deploy 1.4.2" }).expect(201);
    await api()
      .post("/api/v1/incidents/1/status")
      .set(sam)
      .send({ status: "resolved", message: "rollback fixed it" })
      .expect(200);

    const detail = await api().get("/api/v1/incidents/1").set(sam);
    expect(detail.body.incident).toMatchObject({ status: "resolved", service_status: "operational" });
    expect(detail.body.timeline.map((e: { type: string }) => e.type)).toEqual([
      "incident_created",
      "acknowledged",
      "status_changed",
      "note",
      "resolved",
      "postmortem_generated",
    ]);
    expect(detail.body.responders).toEqual([expect.objectContaining({ name: "Sam", role: "commander" })]);

    const pm = await api().get("/api/v1/incidents/1/postmortem").set(sam);
    expect(pm.body.postmortem).toMatchObject({ status: "draft", resolution: "Resolved: rollback fixed it (Sam)" });
    expect(pm.body.postmortem.metrics.alertCount).toBe(1);

    const audit = await api().get("/api/v1/audit-log").set(await t.as("alex"));
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["incident.create", "incident.acknowledged", "incident.investigating", "incident.note", "incident.resolved"])
    );
  });

  it("rejects transitions the state machine forbids", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const sam = await t.as("sam");
    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "investigating" }).expect(200);
    const back = await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "acknowledged" });
    expect(back.status).toBe(409);
    expect(back.body.error).toMatch(/investigating.*acknowledged/);
  });

  it("serializes concurrent acknowledgements: exactly one wins", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const [sam, jordan] = [await t.as("sam"), await t.as("jordan")];
    const results = await Promise.all([
      api().post("/api/v1/incidents/1/acknowledge").set(sam),
      api().post("/api/v1/incidents/1/acknowledge").set(jordan),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("reopens a resolved incident and refuses to reopen when a newer one tracks the alert", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const sam = await t.as("sam");
    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);
    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "investigating" }).expect(200);
    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);

    await t.alert(TEST_KEYS.checkout, critical); // INC-2 for the same dedup key
    const reopen = await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "investigating" });
    expect(reopen.status).toBe(409);
  });

  it("supports manually declared incidents with severity changes and responders", async () => {
    const alex = await t.as("alex");
    const created = await api()
      .post("/api/v1/incidents")
      .set(alex)
      .send({ title: "Our checkout service is down", severity: "sev2", serviceId: t.fx.services.checkout });
    expect(created.status).toBe(201);
    expect(created.body.incident).toMatchObject({ number: 1, severity: "sev2" });

    await api().post("/api/v1/incidents/1/severity").set(alex).send({ severity: "sev1" }).expect(200);
    await api().post("/api/v1/incidents/1/responders").set(alex).send({ userId: t.fx.users.jordan }).expect(201);
    // Users from another organization can't be added.
    await api().post("/api/v1/incidents/1/responders").set(alex).send({ userId: t.fx.users.eve }).expect(404);

    const detail = await api().get("/api/v1/incidents/1").set(alex);
    expect(detail.body.incident.service_status).toBe("outage");
    expect(detail.body.responders.map((r: { name: string }) => r.name).sort()).toEqual(["Alex", "Jordan"]);
  });

  it("only drafts postmortems for resolved incidents, and saves edits", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const sam = await t.as("sam");
    expect((await api().post("/api/v1/incidents/1/postmortem").set(sam)).status).toBe(409);

    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);
    const saved = await api()
      .put("/api/v1/incidents/1/postmortem")
      .set(sam)
      .send({
        rootCause: "Expired TLS certificate on the payment provider client",
        actionItems: [{ description: "Alert 14 days before certificate expiry", owner: "Sam" }],
        status: "published",
      });
    expect(saved.body.postmortem).toMatchObject({
      status: "published",
      root_cause: "Expired TLS certificate on the payment provider client",
      action_items: [{ description: "Alert 14 days before certificate expiry", owner: "Sam", done: false }],
    });

    // Regenerating refreshes metrics but keeps the written narrative.
    await api().post("/api/v1/incidents/1/postmortem").set(sam).expect(201);
    const pm = await api().get("/api/v1/incidents/1/postmortem").set(sam);
    expect(pm.body.postmortem.root_cause).toBe("Expired TLS certificate on the payment provider client");
  });
});

describe("multi-tenancy and roles", () => {
  it("keeps organizations isolated", async () => {
    await t.alert(TEST_KEYS.checkout, critical); // acme INC-1
    const other = await t.alert(TEST_KEYS.other, critical); // other org gets its own INC-1
    expect(other.body.incident.number).toBe(1);

    const eve = await t.as("eve");
    const list = await api().get("/api/v1/incidents").set(eve);
    expect(list.body.incidents).toHaveLength(1);
    expect(list.body.incidents[0].service_name).toBe("Other API");

    // Eve's INC-1 is not Acme's INC-1, and she can't act on Acme's.
    const detail = await api().get("/api/v1/incidents/1").set(eve);
    expect(detail.body.incident.service_name).toBe("Other API");
    const users = await api().get("/api/v1/users").set(eve);
    expect(users.body.users.map((u: { name: string }) => u.name)).toEqual(["Eve"]);
  });

  it("restricts service management and the audit log to admins", async () => {
    const sam = await t.as("sam");
    expect((await api().post("/api/v1/services").set(sam).send({ name: "New" })).status).toBe(403);
    expect((await api().get("/api/v1/audit-log").set(sam)).status).toBe(403);

    const alex = await t.as("alex");
    const created = await api().post("/api/v1/services").set(alex).send({ name: "Search API" });
    expect(created.status).toBe(201);
    // The returned key works for ingestion right away (and is stored only as a hash).
    const res = await t.alert(created.body.integrationKey, critical);
    expect(res.body.decision).toBe("incident_created");
    const { rows } = await t.deps.pool.query(`SELECT integration_key_hash FROM services WHERE name = 'Search API'`);
    expect(rows[0].integration_key_hash).not.toContain(created.body.integrationKey);
  });

  it("replaces alert rules and applies them to new alerts", async () => {
    const alex = await t.as("alex");
    await api()
      .put(`/api/v1/services/${t.fx.services.auth}/rules`)
      .set(alex)
      .send({
        rules: [
          {
            name: "Page on login warnings",
            conditions: [{ field: "summary", op: "contains", value: "login" }],
            action: "create_incident",
            incidentSeverity: "sev3",
          },
        ],
      })
      .expect(200);
    const res = await t.alert(TEST_KEYS.auth, { summary: "Login errors rising", severity: "warning", source: "probe" });
    expect(res.body.decision).toBe("incident_created");
    const { rows } = await t.deps.pool.query(`SELECT severity FROM incidents`);
    expect(rows[0].severity).toBe("sev3");
  });
});

describe("dashboard data", () => {
  it("reports open incidents and response metrics", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    await t.alert(TEST_KEYS.auth, { ...critical, summary: "Auth down" });
    const sam = await t.as("sam");
    await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);

    const stats = await api().get("/api/v1/stats").set(sam);
    expect(stats.body.stats).toMatchObject({ open_incidents: 2, unacknowledged: 1, incidents_30d: 2 });
    const services = await api().get("/api/v1/services").set(sam);
    expect(services.body.services.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ["Auth Service", "outage"],
      ["Checkout API", "outage"],
    ]);
  });
});
