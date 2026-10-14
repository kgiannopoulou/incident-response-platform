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

async function incidentWithHistory() {
  await t.alert(TEST_KEYS.checkout, critical);
  const sam = await t.as("sam");
  await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
  await api().post("/api/v1/incidents/1/notes").set(sam).send({ message: "Database connections appear exhausted" }).expect(201);
  await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "investigating" }).expect(200);
  return sam;
}

describe("timeline events", () => {
  it("records every action with its event type, actor and metadata", async () => {
    const sam = await incidentWithHistory();
    const res = await api().get("/api/v1/incidents/1/timeline").set(sam);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { event_type: string; actor_name: string | null }) => [e.event_type, e.actor_name])).toEqual([
      ["INCIDENT_CREATED", null],
      ["INCIDENT_ACKNOWLEDGED", "Sam"],
      ["NOTE_ADDED", "Sam"],
      ["STATUS_CHANGED", "Sam"],
    ]);
    expect(res.body.events[3]).toMatchObject({
      event_type: "STATUS_CHANGED",
      actor_id: t.fx.users.sam,
      metadata: { from: "acknowledged", to: "investigating" },
    });
  });

  it("offers no API to edit or delete events", async () => {
    const sam = await incidentWithHistory();
    const { body } = await api().get("/api/v1/incidents/1/timeline").set(sam);
    const id = body.events[2].id;
    expect((await api().put(`/api/v1/incidents/1/timeline/${id}`).set(sam).send({ message: "x" })).status).toBe(404);
    expect((await api().patch(`/api/v1/incidents/1/timeline/${id}`).set(sam).send({ message: "x" })).status).toBe(404);
    expect((await api().delete(`/api/v1/incidents/1/timeline/${id}`).set(sam)).status).toBe(404);
  });

  it("is append-only in the database: UPDATE and DELETE are rejected", async () => {
    await incidentWithHistory();
    await expect(t.deps.pool.query(`UPDATE timeline_events SET message = 'nothing happened'`)).rejects.toThrow(
      "timeline_events is append-only: UPDATE is not allowed"
    );
    await expect(t.deps.pool.query(`DELETE FROM timeline_events WHERE event_type = 'NOTE_ADDED'`)).rejects.toThrow(
      "timeline_events is append-only: DELETE is not allowed"
    );
    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n FROM timeline_events`);
    expect(rows[0].n).toBe(4);
  });

  it("still lets a whole incident be deleted (its events cascade)", async () => {
    await incidentWithHistory();
    await t.deps.pool.query(`DELETE FROM incidents`);
    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n FROM timeline_events`);
    expect(rows[0].n).toBe(0);
  });

  it("only accepts known event types", async () => {
    await incidentWithHistory();
    await expect(
      t.deps.pool.query(`INSERT INTO timeline_events (incident_id, event_type, message) VALUES (1, 'MADE_UP', 'x')`)
    ).rejects.toThrow(/timeline_events_event_type_check/);
  });
});

describe("hash chain", () => {
  it("links each event to the previous one and verifies", async () => {
    const sam = await incidentWithHistory();
    const { body } = await api().get("/api/v1/incidents/1/timeline").set(sam);
    expect(body.integrity).toEqual({ valid: true, events: 4, first_invalid_id: null });
    expect(body.events[0].prev_hash).toBeNull();
    for (let i = 1; i < body.events.length; i++) {
      expect(body.events[i].prev_hash).toBe(body.events[i - 1].hash);
      expect(body.events[i].hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("chains each incident separately", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    await t.alert(TEST_KEYS.auth, critical);
    const { rows } = await t.deps.pool.query(`SELECT incident_id, prev_hash FROM timeline_events ORDER BY id`);
    expect(rows).toEqual([
      { incident_id: 1, prev_hash: null },
      { incident_id: 2, prev_hash: null },
    ]);
  });

  it("stays intact under concurrent appends", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const [sam, jordan] = [await t.as("sam"), await t.as("jordan")];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        api().post("/api/v1/incidents/1/notes").set(i % 2 ? sam : jordan).send({ message: `finding ${i}` }).expect(201)
      )
    );
    const { body } = await api().get("/api/v1/incidents/1/timeline").set(sam);
    expect(body.integrity).toEqual({ valid: true, events: 11, first_invalid_id: null });
  });

  it("detects history edited behind the triggers' back", async () => {
    const sam = await incidentWithHistory();
    const { body } = await api().get("/api/v1/incidents/1/timeline").set(sam);
    const note = body.events.find((e: { event_type: string }) => e.event_type === "NOTE_ADDED");

    // Someone with owner rights disables the guard and rewrites a note.
    const client = await t.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE timeline_events DISABLE TRIGGER timeline_events_no_update`);
      await client.query(`UPDATE timeline_events SET message = 'All good, nothing to see' WHERE id = $1`, [note.id]);
      await client.query(`ALTER TABLE timeline_events ENABLE TRIGGER timeline_events_no_update`);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const after = await api().get("/api/v1/incidents/1/timeline").set(sam);
    expect(after.body.integrity).toEqual({ valid: false, events: 3, first_invalid_id: note.id });
    // The incident page shows it too.
    const detail = await api().get("/api/v1/incidents/1").set(sam);
    expect(detail.body.timeline_integrity.valid).toBe(false);
  });

  it("detects a deleted event", async () => {
    const sam = await incidentWithHistory();
    const client = await t.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE timeline_events DISABLE TRIGGER timeline_events_no_delete`);
      await client.query(`DELETE FROM timeline_events WHERE event_type = 'INCIDENT_ACKNOWLEDGED'`);
      await client.query(`ALTER TABLE timeline_events ENABLE TRIGGER timeline_events_no_delete`);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const after = await api().get("/api/v1/incidents/1/timeline").set(sam);
    expect(after.body.integrity).toMatchObject({ valid: false, events: 2 });
  });

  it("keeps other organizations out", async () => {
    await incidentWithHistory();
    expect((await api().get("/api/v1/incidents/1/timeline").set(await t.as("eve"))).status).toBe(404);
  });
});
