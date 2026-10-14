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

const api = () => request(t.app);
const BASE = "/api/v1/escalation-policies";

// The plan's example: team first, then the lead after 5 minutes, then the
// manager after 10, all measured from when the incident triggered.
const checkoutPolicy = () => ({
  name: "Checkout escalation",
  description: "Backend team, then lead, then manager",
  steps: [
    { delayMinutes: 0, targets: [{ targetType: "team", targetId: t.fx.teamId }] },
    { delayMinutes: 5, targets: [{ targetType: "user", targetId: t.fx.users.alex }] },
    { delayMinutes: 10, targets: [{ targetType: "user", targetId: t.fx.users.jordan }] },
  ],
});

describe("escalation policy API", () => {
  it("lists policies with ordered steps, named targets and the services using them", async () => {
    const res = await api().get(BASE).set(await t.as("sam"));
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(1);
    const [policy] = res.body.policies;
    expect(policy).toMatchObject({ name: "Payments on-call", services: [{ name: "Checkout API" }] });
    expect(policy.steps).toEqual([
      { position: 1, delayMinutes: 0, targets: [{ targetType: "user", targetId: t.fx.users.sam, name: "Sam" }] },
      { position: 2, delayMinutes: 1, targets: [{ targetType: "user", targetId: t.fx.users.alex, name: "Alex" }] },
      { position: 3, delayMinutes: 2, targets: [{ targetType: "team", targetId: t.fx.teamId, name: "Payments" }] },
    ]);
  });

  it("creates, replaces and deletes a policy (admins only), with an audit trail", async () => {
    const alex = await t.as("alex");
    expect((await api().post(BASE).set(await t.as("sam")).send(checkoutPolicy())).status).toBe(403);

    const created = await api().post(BASE).set(alex).send(checkoutPolicy());
    expect(created.status).toBe(201);
    expect(created.body.policy.steps.map((s: { delayMinutes: number }) => s.delayMinutes)).toEqual([0, 5, 10]);
    const id = created.body.policy.id;

    expect((await api().post(BASE).set(alex).send(checkoutPolicy())).status).toBe(409); // same name

    const replaced = await api()
      .put(`${BASE}/${id}`)
      .set(alex)
      .send({ ...checkoutPolicy(), steps: [{ delayMinutes: 0, targets: [{ targetType: "user", targetId: t.fx.users.sam }] }] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.policy.steps).toEqual([
      { position: 1, delayMinutes: 0, targets: [{ targetType: "user", targetId: t.fx.users.sam, name: "Sam" }] },
    ]);
    // Old steps and their targets are gone, not orphaned.
    const { rows } = await t.deps.pool.query(
      `SELECT count(*)::int AS n FROM escalation_step_targets t JOIN escalation_steps s ON s.id = t.step_id WHERE s.policy_id = $1`,
      [id]
    );
    expect(rows[0].n).toBe(1);

    await api().delete(`${BASE}/${id}`).set(alex).expect(204);
    expect((await api().get(`${BASE}/${id}`).set(alex)).status).toBe(404);

    const { rows: audit } = await t.deps.pool.query(
      `SELECT action FROM audit_log WHERE entity_type = 'escalation_policy' ORDER BY id`
    );
    expect(audit.map((a) => a.action)).toEqual([
      "escalation_policy.create",
      "escalation_policy.update",
      "escalation_policy.delete",
    ]);
  });

  it("validates step order and refuses targets from another organization", async () => {
    const alex = await t.as("alex");
    const unordered = await api()
      .post(BASE)
      .set(alex)
      .send({ ...checkoutPolicy(), steps: [...checkoutPolicy().steps].reverse() });
    expect(unordered.status).toBe(400);

    const foreign = await api()
      .post(BASE)
      .set(alex)
      .send({ name: "Sneaky", steps: [{ delayMinutes: 0, targets: [{ targetType: "user", targetId: t.fx.users.eve }] }] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatch(/Unknown user/);
  });

  it("won't delete a policy a service still uses, and hides other tenants' policies", async () => {
    const alex = await t.as("alex");
    const inUse = await api().delete(`${BASE}/${t.fx.policyId}`).set(alex);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error).toMatch(/Checkout API/);

    const eve = await t.as("eve");
    expect((await api().get(BASE).set(eve)).body.policies).toEqual([]);
    expect((await api().get(`${BASE}/${t.fx.policyId}`).set(eve)).status).toBe(404);
    expect((await api().put(`${BASE}/${t.fx.policyId}`).set(eve).send(checkoutPolicy())).status).toBe(404);
  });
});

describe("escalation timing", () => {
  it("schedules each step relative to when the incident triggered", async () => {
    const alex = await t.as("alex");
    const created = await api().post(BASE).set(alex).send(checkoutPolicy());
    await api().patch(`/api/v1/services/${t.fx.services.checkout}`).set(alex).send({ escalationPolicyId: created.body.policy.id }).expect(200);

    await t.alert(TEST_KEYS.checkout, { title: "Checkout down", severity: "critical", source: "probe" });
    const sam = await t.as("sam");
    // Step 1 (0 min) is due immediately.
    const { rows } = await t.deps.pool.query(`SELECT triggered_at, next_escalation_at FROM incidents`);
    expect(rows[0].next_escalation_at.getTime() - rows[0].triggered_at.getTime()).toBeLessThan(1000);

    // Paging step 1 by hand schedules step 2 at trigger + 5 min, not now + 5.
    const res = await api().post("/api/v1/incidents/1/escalate").set(sam);
    const offset = new Date(res.body.incident.next_escalation_at).getTime() - rows[0].triggered_at.getTime();
    expect(offset).toBe(5 * 60_000);

    const { rows: paged } = await t.deps.pool.query(
      `SELECT u.name FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.escalation_level = 1 ORDER BY u.name`
    );
    expect(paged.map((p) => p.name)).toEqual(["Alex", "Sam"]); // the Payments team
  });
});
