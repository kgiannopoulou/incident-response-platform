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
const critical = { title: "Checkout down", severity: "critical", source: "probe" };

async function responders() {
  const res = await api().get("/api/v1/incidents/1").set(await t.as("alex"));
  return res.body.responders.map((r: { name: string; role: string }) => [r.name, r.role]);
}

async function timelineOf(type: string) {
  const { rows } = await t.deps.pool.query(
    `SELECT message, metadata FROM timeline_events WHERE event_type = $1 ORDER BY id`,
    [type]
  );
  return rows;
}

describe("responders", () => {
  it("lets people join as responder or observer, commander first", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const [sam, jordan, alex] = [await t.as("sam"), await t.as("jordan"), await t.as("alex")];

    await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200); // Sam becomes commander
    await api().post("/api/v1/incidents/1/responders").set(jordan).send({}).expect(201);
    await api().post("/api/v1/incidents/1/responders").set(alex).send({ role: "observer" }).expect(201);

    expect(await responders()).toEqual([
      ["Sam", "commander"],
      ["Jordan", "responder"],
      ["Alex", "observer"],
    ]);
    const detail = await api().get("/api/v1/incidents/1").set(sam);
    expect(detail.body.responders[1].joined_at).toBeTruthy();
    expect((await timelineOf("RESPONDER_ADDED")).map((e) => e.message)).toEqual([
      "Jordan joined as Responder",
      "Alex joined as Observer",
    ]);

    // Joining again with the same role is a no-op.
    const again = await api().post("/api/v1/incidents/1/responders").set(jordan).send({});
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
  });

  it("keeps observers read-only until they join as responder", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const jordan = await t.as("jordan");
    await api().post("/api/v1/incidents/1/responders").set(jordan).send({ role: "observer" }).expect(201);

    for (const [path, body] of [
      ["/acknowledge", undefined],
      ["/status", { status: "resolved" }],
      ["/severity", { severity: "sev3" }],
      ["/notes", { message: "hello" }],
      ["/escalate", undefined],
    ] as const) {
      const res = await api().post(`/api/v1/incidents/1${path}`).set(jordan).send(body);
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body.error).toMatch(/Observers can't change the incident/);
    }

    await api().patch(`/api/v1/incidents/1/responders/${t.fx.users.jordan}`).set(jordan).send({ role: "responder" }).expect(200);
    await api().post("/api/v1/incidents/1/acknowledge").set(jordan).expect(200);
    expect(await timelineOf("RESPONDER_ROLE_CHANGED")).toEqual([
      {
        message: "Jordan switched from Observer to Responder",
        metadata: { userId: t.fx.users.jordan, from: "observer", to: "responder" },
      },
    ]);
  });

  it("hands over command: exactly one commander, previous one becomes responder", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const [sam, jordan] = [await t.as("sam"), await t.as("jordan")];
    await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
    await api().post("/api/v1/incidents/1/responders").set(jordan).send({}).expect(201);

    // Jordan can't take command while Sam has it...
    const grab = await api().patch(`/api/v1/incidents/1/responders/${t.fx.users.jordan}`).set(jordan).send({ role: "commander" });
    expect(grab.status).toBe(403);
    // ...but Sam can hand it over.
    await api().patch(`/api/v1/incidents/1/responders/${t.fx.users.jordan}`).set(sam).send({ role: "commander" }).expect(200);

    expect(await responders()).toEqual([
      ["Jordan", "commander"],
      ["Sam", "responder"],
    ]);
    const detail = await api().get("/api/v1/incidents/1").set(sam);
    expect(detail.body.incident).toMatchObject({ commander_id: t.fx.users.jordan, commander_name: "Jordan" });
    expect((await timelineOf("COMMANDER_ASSIGNED")).map((e) => e.message)).toEqual(["Jordan is now Incident Commander (by Sam)"]);
  });

  it("lets anyone take command of an incident without one, and admins reassign it", async () => {
    await t.alert(TEST_KEYS.checkout, critical); // opened by an alert: no commander yet
    const [jordan, alex] = [await t.as("jordan"), await t.as("alex")];
    await api().post("/api/v1/incidents/1/responders").set(jordan).send({ role: "commander" }).expect(201);
    await api().patch(`/api/v1/incidents/1/responders/${t.fx.users.sam}`).set(alex).send({ role: "commander" }).expect(200);
    expect(await responders()).toEqual([
      ["Sam", "commander"],
      ["Jordan", "responder"],
    ]);
  });

  it("allows a single commander even when two hand-overs race", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const alex = await t.as("alex");
    await Promise.all([
      api().patch(`/api/v1/incidents/1/responders/${t.fx.users.sam}`).set(alex).send({ role: "commander" }),
      api().patch(`/api/v1/incidents/1/responders/${t.fx.users.jordan}`).set(alex).send({ role: "commander" }),
    ]);
    const { rows } = await t.deps.pool.query(
      `SELECT count(*)::int AS commanders FROM incident_responders WHERE role = 'commander'`
    );
    expect(rows[0].commanders).toBe(1);
  });

  it("doesn't let the commander step down or leave without handing over", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const sam = await t.as("sam");
    await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
    const stepDown = await api().patch(`/api/v1/incidents/1/responders/${t.fx.users.sam}`).set(sam).send({ role: "observer" });
    expect(stepDown.status).toBe(409);
    expect((await api().delete(`/api/v1/incidents/1/responders/${t.fx.users.sam}`).set(sam)).status).toBe(409);
  });

  it("lets people leave, and only the commander or an admin remove others", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const [sam, jordan, alex] = [await t.as("sam"), await t.as("jordan"), await t.as("alex")];
    await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
    await api().post("/api/v1/incidents/1/responders").set(jordan).send({}).expect(201);
    await api().post("/api/v1/incidents/1/responders").set(alex).send({ role: "observer" }).expect(201);

    // A plain responder can't remove someone else.
    expect((await api().delete(`/api/v1/incidents/1/responders/${t.fx.users.alex}`).set(jordan)).status).toBe(403);
    // People can leave themselves; the commander can remove others.
    await api().delete(`/api/v1/incidents/1/responders/${t.fx.users.alex}`).set(alex).expect(204);
    await api().delete(`/api/v1/incidents/1/responders/${t.fx.users.jordan}`).set(sam).expect(204);
    expect(await responders()).toEqual([["Sam", "commander"]]);
    expect((await timelineOf("RESPONDER_REMOVED")).map((e) => e.message)).toEqual([
      "Alex left the incident",
      "Sam removed Jordan from the incident",
    ]);
    expect((await api().delete(`/api/v1/incidents/1/responders/${t.fx.users.jordan}`).set(sam)).status).toBe(404);
  });

  it("freezes responders once the incident is resolved, and keeps tenants apart", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const sam = await t.as("sam");
    await api().post("/api/v1/incidents/1/responders").set(sam).send({ userId: t.fx.users.eve }).expect(404);
    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);
    expect((await api().post("/api/v1/incidents/1/responders").set(await t.as("jordan")).send({})).status).toBe(409);
  });

  it("counts responders but not observers in the postmortem", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const [sam, jordan, alex] = [await t.as("sam"), await t.as("jordan"), await t.as("alex")];
    await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
    await api().post("/api/v1/incidents/1/responders").set(jordan).send({}).expect(201);
    await api().post("/api/v1/incidents/1/responders").set(alex).send({ role: "observer" }).expect(201);
    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);
    const pm = await api().get("/api/v1/incidents/1/postmortem").set(sam);
    expect(pm.body.postmortem.metrics.responderCount).toBe(2);
  });
});
