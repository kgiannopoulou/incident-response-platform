import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { createTestContext, type TestContext } from "./helpers";

// Phase 20: authorization in a multi-tenant SaaS. "Org A cannot read Org B
// incidents" — checked for every route that takes an id, as an *admin* of
// the other organization (the most privileged outsider), followed by a
// check that nothing in Org A changed. 404, not 403: another tenant's ids
// shouldn't even be confirmed to exist.

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const api = () => request(t.app);

type World = Awaited<ReturnType<typeof acmeWorld>>;

// Acme (org A) with one of everything: a resolved incident with alerts,
// responders, a postmortem with an action item and an AI draft, a webhook
// endpoint with a delivery, and a dead-lettered job.
async function acmeWorld() {
  const alex = await t.as("alex");
  const sam = await t.as("sam");
  const { body: hook } = await api()
    .post("/api/v1/webhooks")
    .set(alex)
    .send({ url: "http://127.0.0.1:9/acme-hook", events: ["incident.triggered"] })
    .expect(201);
  await t.alert(TEST_KEYS.checkout, { title: "Acme checkout down", severity: "critical", source: "prometheus", deduplicationKey: "acme-5xx" }).expect(202);
  await api().post("/api/v1/incidents/1/responders").set(sam).send({ role: "responder" }).expect(201);
  await api().post("/api/v1/incidents/1/notes").set(sam).send({ message: "Acme secret note" }).expect(201);
  await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);
  const { body: draft } = await api().post("/api/v1/incidents/1/postmortem/ai-drafts").set(sam).expect(202);
  const { body: pm } = await api().get("/api/v1/incidents/1/postmortem").set(sam).expect(200);
  const { rows: deliveries } = await t.deps.pool.query(`SELECT id FROM webhook_deliveries LIMIT 1`);
  const dead = await t.deps.queues.deadLetter.add("notifications:deliver", {
    queue: "notifications",
    name: "deliver",
    jobId: "notification-1",
    data: { notificationId: 1 },
    failedReason: "SMTP down",
    attemptsMade: 5,
    failedAt: new Date().toISOString(),
    organizationId: t.fx.orgs.acme,
  });
  return {
    webhookId: hook.endpoint?.id ?? hook.id,
    deliveryId: deliveries[0].id as number,
    draftId: draft.draft.id as number,
    actionItemId: pm.postmortem.action_items[0].id as string,
    deadLetterId: dead.id!,
  };
}

// Everything in Acme that a request could change, to compare before/after.
async function acmeSnapshot() {
  const q = async (sql: string) => (await t.deps.pool.query(sql, [t.fx.orgs.acme])).rows;
  return {
    incidents: await q(`SELECT number, status, severity, title, escalation_level FROM incidents WHERE organization_id = $1 ORDER BY id`),
    timeline: await q(`SELECT count(*)::int AS n FROM timeline_events t JOIN incidents i ON i.id = t.incident_id WHERE i.organization_id = $1`),
    responders: await q(`SELECT r.user_id, r.role FROM incident_responders r JOIN incidents i ON i.id = r.incident_id WHERE i.organization_id = $1 ORDER BY 1`),
    postmortems: await q(`SELECT p.status, p.summary, p.action_items, p.ai_review_pending FROM postmortems p JOIN incidents i ON i.id = p.incident_id WHERE i.organization_id = $1`),
    drafts: await q(`SELECT id, status FROM postmortem_ai_drafts WHERE organization_id = $1 ORDER BY id`),
    services: await q(`SELECT id, name, status, escalation_policy_id FROM services WHERE organization_id = $1 ORDER BY id`),
    keys: await q(`SELECT id, name, revoked_at, expires_at FROM api_keys WHERE organization_id = $1 ORDER BY id`),
    rules: await q(`SELECT r.id, r.name FROM alert_rules r JOIN services s ON s.id = r.service_id WHERE s.organization_id = $1 ORDER BY 1`),
    policies: await q(`SELECT id, name, ack_timeout_minutes FROM escalation_policies WHERE organization_id = $1 ORDER BY id`),
    webhooks: await q(`SELECT id, url, enabled, secret FROM webhook_endpoints WHERE organization_id = $1 ORDER BY id`),
    deliveries: await q(`SELECT id, status, attempts FROM webhook_deliveries WHERE organization_id = $1 ORDER BY id`),
    alerts: await q(`SELECT count(*)::int AS n FROM alerts WHERE organization_id = $1`),
  };
}

// Every route that addresses an Acme object by id or incident number.
function targetedRoutes(w: World) {
  const { checkout } = t.fx.services;
  const key = t.fx.apiKeys.checkout;
  const policy = t.fx.policyId;
  const alex = t.fx.users.alex;
  const routes: [method: "get" | "post" | "put" | "patch" | "delete", path: string, body?: object][] = [
    ["get", "/incidents/1"],
    ["get", "/incidents/1/timeline"],
    ["post", "/incidents/1/status", { status: "investigating" }],
    ["post", "/incidents/1/acknowledge"],
    ["post", "/incidents/1/escalate"],
    ["post", "/incidents/1/severity", { severity: "sev4" }],
    ["post", "/incidents/1/notes", { message: "hello from another tenant" }],
    ["post", "/incidents/1/responders", { role: "observer" }],
    ["patch", `/incidents/1/responders/${alex}`, { role: "observer" }],
    ["delete", `/incidents/1/responders/${alex}`],
    ["get", "/incidents/1/postmortem"],
    ["get", "/incidents/1/postmortem/markdown"],
    ["post", "/incidents/1/postmortem"],
    ["put", "/incidents/1/postmortem", { summary: "rewritten by another tenant" }],
    ["patch", `/incidents/1/postmortem/action-items/${w.actionItemId}`, { done: true }],
    ["post", "/incidents/1/postmortem/ai-drafts"],
    ["post", `/incidents/1/postmortem/ai-drafts/${w.draftId}/apply`, { sections: ["summary"] }],
    ["post", `/incidents/1/postmortem/ai-drafts/${w.draftId}/discard`],
    ["patch", `/services/${checkout}`, { name: "Owned" }],
    ["get", `/services/${checkout}/keys`],
    ["post", `/services/${checkout}/keys`, { name: "backdoor" }],
    ["post", `/services/${checkout}/keys/${key}/rotate`, { graceMinutes: 0 }],
    ["post", `/services/${checkout}/keys/${key}/revoke`],
    ["get", `/services/${checkout}/rules`],
    ["put", `/services/${checkout}/rules`, { rules: [] }],
    ["get", `/escalation-policies/${policy}`],
    ["put", `/escalation-policies/${policy}`, { name: "Owned", steps: [{ delayMinutes: 0, targets: [{ targetType: "user", targetId: t.fx.users.eve }] }] }],
    ["delete", `/escalation-policies/${policy}`],
    ["patch", `/webhooks/${w.webhookId}`, { enabled: false }],
    ["post", `/webhooks/${w.webhookId}/rotate-secret`],
    ["post", `/webhooks/${w.webhookId}/test`],
    ["get", `/webhooks/${w.webhookId}/deliveries`],
    ["post", `/webhooks/deliveries/${w.deliveryId}/redeliver`],
    ["delete", `/webhooks/${w.webhookId}`],
    ["post", `/admin/dead-letter/${w.deadLetterId}/retry`],
    ["delete", `/admin/dead-letter/${w.deadLetterId}`],
  ];
  return routes;
}

describe("tenant isolation: Org B (Eve, admin) against Org A's ids", () => {
  it("gets 404 on every route that names an Org A object, and changes nothing", async () => {
    const world = await acmeWorld();
    const before = await acmeSnapshot();
    const eve = await t.as("eve");

    const results: string[] = [];
    for (const [method, path, body] of targetedRoutes(world)) {
      const res = await api()[method](`/api/v1${path}`).set(eve).send(body);
      results.push(`${res.status} ${method.toUpperCase()} ${path}`);
      // Nothing about the object leaks into the error either.
      expect(JSON.stringify(res.body)).not.toMatch(/Acme|Checkout|secret note/);
    }
    expect(results.filter((r) => !r.startsWith("404"))).toEqual([]);

    expect(await acmeSnapshot()).toEqual(before);
    expect(await t.deps.queues.deadLetter.getJob(world.deadLetterId)).toBeTruthy();
    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = $1 AND organization_id = $2`, [
      t.fx.users.eve,
      t.fx.orgs.acme,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("sees none of Org A's data in any list, feed or metric (live-stream isolation: realtime.test.ts)", async () => {
    await acmeWorld();
    const eve = await t.as("eve");
    const lists = [
      "/incidents",
      "/incidents?status=open",
      "/alerts",
      "/services",
      "/escalation-policies",
      "/webhooks",
      "/postmortems",
      "/users",
      "/teams",
      "/audit-log",
      "/admin/dead-letter",
      "/metrics?days=90",
      "/stats",
      "/incidents/1/postmortem/ai-drafts",
      "/auth/me",
    ];
    for (const path of lists) {
      const res = await api().get(`/api/v1${path}`).set(eve);
      expect([path, res.status]).toEqual([path, 200]);
      expect([path, JSON.stringify(res.body)]).not.toEqual([path, expect.stringMatching(/Acme|Checkout|Payments|Alex|Sam|Jordan|acme-5xx/)]);
    }
    const metrics = (await api().get("/api/v1/metrics").set(eve)).body;
    expect(metrics.summary.incidents).toBe(0);
    // The built-in demo scenario is the same text for everyone; the run state is per organization.
    await t.deps.redis.set(`irp:demo:org:${t.fx.orgs.acme}`, JSON.stringify({ runId: "acme-run", startedBy: "Alex" }));
    expect((await api().get("/api/v1/demo").set(eve)).body.run).toBeNull();
  });

  it("numbers incidents per organization: Org B's INC-1 is its own", async () => {
    await t.alert(TEST_KEYS.checkout, { title: "Acme checkout down", severity: "critical", source: "probe" }).expect(202);
    await t.alert(TEST_KEYS.other, { title: "Other org outage", severity: "critical", source: "probe" }).expect(202);
    const eve = await t.as("eve");
    const sam = await t.as("sam");
    expect((await api().get("/api/v1/incidents/1").set(eve)).body.incident.title).toBe("Other org outage");
    expect((await api().get("/api/v1/incidents/1").set(sam)).body.incident.title).toBe("Acme checkout down");
    // Acting on "INC-1" acts on your own organization's INC-1 only.
    await api().post("/api/v1/incidents/1/acknowledge").set(eve).expect(200);
    const { rows } = await t.deps.pool.query(`SELECT o.slug, i.status FROM incidents i JOIN organizations o ON o.id = i.organization_id ORDER BY o.slug`);
    expect(rows).toEqual([
      { slug: "acme", status: "triggered" },
      { slug: "other", status: "acknowledged" },
    ]);
  });
});

describe("API keys are tenant-bound", () => {
  it("an Org B key can't alert as, or resolve alerts of, an Org A service", async () => {
    await t.alert(TEST_KEYS.checkout, { title: "Acme checkout down", severity: "critical", source: "probe", deduplicationKey: "acme-5xx" }).expect(202);
    const asAcme = await t.alert(TEST_KEYS.other, { service: "checkout-api", title: "spoofed", severity: "critical", source: "probe" });
    expect(asAcme.status).toBe(403);
    // A resolve with the same key only looks inside the key's own service.
    const resolve = await t.alert(TEST_KEYS.other, { action: "resolve", deduplicationKey: "acme-5xx" }).expect(202);
    expect(resolve.body).toMatchObject({ resolvedCount: 0, service: "other-api" });
    const { rows } = await t.deps.pool.query(`SELECT status FROM alerts WHERE dedup_key = 'acme-5xx'`);
    expect(rows).toEqual([{ status: "triggered" }]);
  });
});

describe("roles inside an organization", () => {
  it("keeps admin-only routes away from responders", async () => {
    const world = await acmeWorld();
    const sam = await t.as("sam");
    const { checkout } = t.fx.services;
    const adminOnly: [method: "get" | "post" | "put" | "patch" | "delete", path: string, body?: object][] = [
      ["post", "/services", { name: "Shadow", slug: "shadow" }],
      ["patch", `/services/${checkout}`, { name: "Renamed" }],
      ["get", `/services/${checkout}/keys`],
      ["post", `/services/${checkout}/keys`, { name: "k" }],
      ["post", `/services/${checkout}/keys/${t.fx.apiKeys.checkout}/revoke`],
      ["put", `/services/${checkout}/rules`, { rules: [] }],
      ["post", "/escalation-policies", { name: "P", steps: [{ delayMinutes: 0, targets: [{ targetType: "user", targetId: t.fx.users.sam }] }] }],
      ["delete", `/escalation-policies/${t.fx.policyId}`],
      ["get", "/webhooks"],
      ["post", "/webhooks", { url: "http://127.0.0.1:9/x", events: ["incident.triggered"] }],
      ["delete", `/webhooks/${world.webhookId}`],
      ["get", "/audit-log"],
      ["get", "/admin/queues"],
      ["get", "/admin/dead-letter"],
      ["post", `/admin/dead-letter/${world.deadLetterId}/retry`],
      ["post", "/demo/simulate", {}],
    ];
    const allowed: string[] = [];
    for (const [method, path, body] of adminOnly) {
      const res = await api()[method](`/api/v1${path}`).set(sam).send(body);
      if (res.status !== 403) allowed.push(`${res.status} ${method.toUpperCase()} ${path}`);
    }
    expect(allowed).toEqual([]);
  });

  it("requires a session everywhere except login and alert ingestion", async () => {
    for (const path of ["/incidents", "/incidents/1", "/services", "/metrics", "/postmortems", "/audit-log", "/stream", "/demo", "/auth/me"]) {
      expect([path, (await api().get(`/api/v1${path}`)).status]).toEqual([path, 401]);
    }
    expect((await api().post("/api/v1/alerts").send({ title: "x", severity: "critical" })).status).toBe(401); // needs an API key instead
  });
});
