import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { investigationJobId, PRODUCTION_INCIDENT, QUEUES } from "@irp/shared";
import { runScenario } from "../src/routes/demo";
import { createTestContext, type TestContext } from "./helpers";

// AI Incident Investigator, API side: change and log ingestion with API keys,
// service dependencies, starting an investigation (a worker job), posting a
// hypothesis to the timeline, and tenant isolation for all of it.

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const post = (path: string, key: string, body: object) => request(t.app).post(`/api/v1${path}`).set("Authorization", `Bearer ${key}`).send(body);
const openIncident = () => t.alert(TEST_KEYS.checkout, { severity: "critical", title: "Checkout down", deduplicationKey: "co" }).expect(202);

describe("POST /deployments and /logs (API key)", () => {
  it("records a deployment for the key's service", async () => {
    const res = await post("/deployments", TEST_KEYS.checkout, {
      version: "v2.14.0",
      commitSha: "E41F9B2",
      description: "Raise worker concurrency",
      startedAt: "2026-10-16T13:54:00Z",
    }).expect(201);
    expect(res.body).toMatchObject({ id: expect.stringMatching(/^deploy_\d+$/), service: "checkout-api", version: "v2.14.0", status: "succeeded", kind: "deploy", startedAt: "2026-10-16T13:54:00.000Z" });
    const { rows } = await t.deps.pool.query(`SELECT commit_sha, organization_id, api_key_id IS NOT NULL AS keyed FROM deployments`);
    expect(rows).toEqual([{ commit_sha: "e41f9b2", organization_id: t.fx.orgs.acme, keyed: true }]);
    const list = await request(t.app).get("/api/v1/deployments").set(await t.as("sam")).expect(200);
    expect(list.body.deployments).toHaveLength(1);
    // Another tenant sees nothing.
    expect((await request(t.app).get("/api/v1/deployments").set(await t.as("eve"))).body.deployments).toEqual([]);
  });

  it("refuses bad keys, another service's name and invalid payloads", async () => {
    await post("/deployments", "ir_live_nope", { version: "v1" }).expect(401);
    await post("/deployments", TEST_KEYS.checkout, { version: "v1", service: "auth-service" }).expect(403);
    await post("/deployments", TEST_KEYS.checkout, { version: "" }).expect(400);
    await post("/logs", TEST_KEYS.checkout, { entries: [] }).expect(400);
    await post("/logs", TEST_KEYS.checkout, { entries: [{ level: "loud", message: "x" }] }).expect(400);
  });

  it("stores log batches with fingerprints and clamps future timestamps", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const res = await post("/logs", TEST_KEYS.checkout, {
      entries: [
        { level: "error", message: "timeout acquiring connection after 5000ms (order 1)" },
        { level: "ERROR", message: "timeout acquiring connection after 4990ms (order 2)", timestamp: future },
        { level: "warning", message: "slow query", attributes: { ms: 812 } },
      ],
    }).expect(202);
    expect(res.body).toEqual({ accepted: 3, service: "checkout-api" });
    const { rows } = await t.deps.pool.query(`SELECT level, fingerprint, ts <= now() AS not_future FROM log_events ORDER BY id`);
    expect(rows.map((r) => r.level)).toEqual(["error", "error", "warn"]);
    expect(rows[0].fingerprint).toBe(rows[1].fingerprint);
    expect(rows.every((r) => r.not_future)).toBe(true);
  });
});

describe("service dependencies", () => {
  it("admins set them; everyone reads them; foreign or self targets are refused", async () => {
    const admin = await t.as("alex");
    const { checkout, auth, other } = t.fx.services;
    await request(t.app).put(`/api/v1/services/${checkout}/dependencies`).set(await t.as("sam")).send({ dependsOn: [auth] }).expect(403);
    await request(t.app).put(`/api/v1/services/${checkout}/dependencies`).set(admin).send({ dependsOn: [other] }).expect(404);
    await request(t.app).put(`/api/v1/services/${checkout}/dependencies`).set(admin).send({ dependsOn: [checkout] }).expect(400);
    await request(t.app).put(`/api/v1/services/${checkout}/dependencies`).set(admin).send({ dependsOn: [auth, auth] }).expect(200);
    const res = await request(t.app).get(`/api/v1/services/${auth}/dependencies`).set(await t.as("sam")).expect(200);
    expect(res.body).toEqual({ dependsOn: [], dependents: [expect.objectContaining({ slug: "checkout-api" })] });
    await request(t.app).get(`/api/v1/services/${checkout}/dependencies`).set(await t.as("eve")).expect(404);
  });
});

describe("investigations", () => {
  it("starts one as a worker job, refuses a second while it runs, and lists it", async () => {
    await openIncident();
    const sam = await t.as("sam");
    const res = await request(t.app).post("/api/v1/incidents/1/investigations").set(sam).expect(202);
    expect(res.body.investigation).toMatchObject({ id: expect.any(Number), status: "queued" });
    expect(await t.deps.queues.investigations.getJob(investigationJobId(res.body.investigation.id))).toBeDefined();
    await request(t.app).post("/api/v1/incidents/1/investigations").set(sam).expect(409);

    const list = await request(t.app).get("/api/v1/incidents/1/investigations").set(sam).expect(200);
    expect(list.body.investigations).toEqual([expect.objectContaining({ status: "queued", requested_by_name: "Sam" })]);
    const { rows } = await t.deps.pool.query(`SELECT action FROM audit_log WHERE action LIKE 'incident.investigation%'`);
    expect(rows).toEqual([{ action: "incident.investigation_requested" }]);
    expect(QUEUES.investigations).toBe("investigations");
  });

  it("posts a completed investigation's hypothesis to the timeline as the responder's note", async () => {
    await openIncident();
    const { rows } = await t.deps.pool.query(
      `INSERT INTO incident_investigations (organization_id, incident_id, status, provider, findings)
       SELECT organization_id, id, 'completed', 'claude', $1 FROM incidents RETURNING id`,
      [
        JSON.stringify({
          summary: "s",
          hypotheses: [{ id: "h1", title: "Deploy v2.14.0 exhausted connections", statement: "The deploy did it.", category: "deployment", confidence: "high", supportingEvidence: ["deploy:1"], contradictingEvidence: [], reasoning: "r", nextChecks: [] }],
          timeline: [],
          openQuestions: [],
        }),
      ]
    );
    const id = rows[0].id;
    const sam = await t.as("sam");
    await request(t.app).post(`/api/v1/incidents/1/investigations/${id}/hypotheses/h1/post`).set(sam).expect(201);
    await request(t.app).post(`/api/v1/incidents/1/investigations/${id}/hypotheses/h9/post`).set(sam).expect(404);
    const { rows: events } = await t.deps.pool.query(`SELECT event_type, message, metadata, actor_id FROM timeline_events WHERE event_type = 'NOTE_ADDED'`);
    expect(events).toEqual([
      {
        event_type: "NOTE_ADDED",
        message: "AI investigator hypothesis (high confidence): Deploy v2.14.0 exhausted connections — The deploy did it.",
        metadata: { investigationId: id, hypothesisId: "h1", evidenceIds: ["deploy:1"], unconfirmed: true },
        actor_id: t.fx.users.sam,
      },
    ]);
  });

  it("keeps another organization out of everything", async () => {
    await openIncident();
    const eve = await t.as("eve");
    await request(t.app).post("/api/v1/incidents/1/investigations").set(eve).expect(404);
    await request(t.app).get("/api/v1/incidents/1/investigations").set(eve).expect(200, { investigations: [] });
    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n FROM incident_investigations`);
    expect(rows[0].n).toBe(0);
  });
});

describe("the simulator feeds the investigator", () => {
  it("reports the scenario's deployments and logs alongside its alerts", async () => {
    // The scenario's Postgres service, so its logs have somewhere to go.
    await t.deps.pool.query(`INSERT INTO services (organization_id, name, slug) VALUES ($1, 'PostgreSQL Primary', 'postgres-primary')`, [t.fx.orgs.acme]);
    const state = { runId: "demo_t", scenario: "checkout-outage", startedBy: "Alex", startedAt: new Date().toISOString(), speed: 5, step: 0, total: PRODUCTION_INCIDENT.steps.length, label: "", done: false, results: [] };
    await runScenario(t.deps, t.fx.orgs.acme, PRODUCTION_INCIDENT, state, 0);
    const { rows: deploys } = await t.deps.pool.query(`SELECT d.version, s.slug, d.metadata->>'simulated' AS simulated FROM deployments d JOIN services s ON s.id = d.service_id ORDER BY d.started_at`);
    expect(deploys).toEqual([
      { version: "v2.13.4", slug: "checkout-api", simulated: "true" },
      { version: "v5.2.1", slug: "auth-service", simulated: "true" },
      { version: "v2.14.0", slug: "checkout-api", simulated: "true" },
    ]);
    const { rows: logs } = await t.deps.pool.query(`SELECT s.slug, l.level, count(*)::int AS n FROM log_events l JOIN services s ON s.id = l.service_id GROUP BY 1, 2 ORDER BY 1, 2`);
    expect(logs).toEqual(
      expect.arrayContaining([
        { slug: "checkout-api", level: "error", n: 190 },
        { slug: "postgres-primary", level: "fatal", n: 25 },
      ])
    );
  });
});
