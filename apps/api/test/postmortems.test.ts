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
const PM = "/api/v1/incidents/1/postmortem";

// "Our checkout service is down": alert storm, a note, mitigation, resolve.
async function resolvedIncident() {
  for (let i = 0; i < 3; i++) {
    await t.alert(TEST_KEYS.checkout, { title: "Checkout API unavailable", severity: "critical", source: "prometheus", deduplicationKey: "checkout-5xx" });
  }
  const sam = await t.as("sam");
  await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
  await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "investigating" }).expect(200);
  await api().post("/api/v1/incidents/1/notes").set(sam).send({ message: "Database connections appear exhausted" }).expect(201);
  await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "mitigated", message: "Pool size raised" }).expect(200);
  await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved", message: "Error rate back to normal" }).expect(200);
  return sam;
}

describe("generated postmortem", () => {
  it("is drafted on resolve with the full document structure and a timeline from the event log", async () => {
    const sam = await resolvedIncident();
    const { body } = await api().get(PM).set(sam);
    const pm = body.postmortem;
    expect(pm).toMatchObject({ status: "draft", number: 1, title: "Checkout API unavailable", severity: "sev1", service_name: "Checkout API" });
    expect(pm.metrics).toMatchObject({ alertCount: 3, notesCount: 1, durationSeconds: expect.any(Number) });
    expect(pm.what_went_well).toContain("Monitoring detected it: prometheus");
    expect(pm.action_items[0]).toMatchObject({ id: expect.stringMatching(/^ai_/), done: false, dueDate: null });

    // Every timeline entry is a real, hash-chained event of this incident.
    const { rows: events } = await t.deps.pool.query(`SELECT id, hash, message FROM timeline_events ORDER BY id`);
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const entry of pm.timeline) {
      expect(byId.get(entry.eventId)).toMatchObject({ hash: entry.hash });
    }
    expect(pm.timeline.map((e: { type: string }) => e.type)).toEqual([
      "INCIDENT_CREATED",
      "ALERT_ATTACHED", // two repeats collapsed into one entry
      "INCIDENT_ACKNOWLEDGED",
      "STATUS_CHANGED",
      "NOTE_ADDED",
      "STATUS_CHANGED",
      "INCIDENT_RESOLVED",
    ]);
    expect(pm.timeline[1].message).toMatch(/^2 more alerts grouped/);
  });

  it("lists postmortems with duration and action-item progress", async () => {
    const sam = await resolvedIncident();
    const { body } = await api().get("/api/v1/postmortems").set(sam);
    expect(body.postmortems).toEqual([
      expect.objectContaining({ number: 1, status: "draft", action_items_total: 1, action_items_done: 0, duration_seconds: expect.any(Number) }),
    ]);
    expect((await api().get("/api/v1/postmortems").set(await t.as("eve"))).body.postmortems).toEqual([]);
  });
});

describe("editing and publishing", () => {
  it("saves every section, hides timeline entries and assigns action-item ids", async () => {
    const sam = await resolvedIncident();
    const before = (await api().get(PM).set(sam)).body.postmortem;
    const note = before.timeline.find((e: { type: string }) => e.type === "NOTE_ADDED");

    const res = await api()
      .put(PM)
      .set(sam)
      .send({
        impact: "Customers were unable to complete checkout.",
        whatWentWell: "Alert fired within a minute.",
        whatWentPoorly: "Pool limits were undocumented.",
        actionItems: [
          { description: "Add DB connection alerts", owner: "Sam", dueDate: "2026-10-21" },
          { description: "Review connection pool limits" },
        ],
        hiddenTimelineEventIds: [note.eventId],
      });
    expect(res.status).toBe(200);
    const pm = res.body.postmortem;
    expect(pm).toMatchObject({
      impact: "Customers were unable to complete checkout.",
      what_went_well: "Alert fired within a minute.",
      what_went_poorly: "Pool limits were undocumented.",
    });
    expect(pm.action_items).toEqual([
      { id: expect.stringMatching(/^ai_/), description: "Add DB connection alerts", owner: "Sam", dueDate: "2026-10-21", done: false },
      { id: expect.stringMatching(/^ai_/), description: "Review connection pool limits", owner: "", dueDate: null, done: false },
    ]);
    expect(pm.timeline.find((e: { eventId: number }) => e.eventId === note.eventId).hidden).toBe(true);
    // The event itself is untouched in the immutable log.
    expect((await t.deps.pool.query(`SELECT count(*)::int AS n FROM timeline_events WHERE id = $1`, [note.eventId])).rows[0].n).toBe(1);

    // Refreshing the data keeps the hidden choice and the written sections.
    await api().post(PM).set(sam).expect(201);
    const refreshed = (await api().get(PM).set(sam)).body.postmortem;
    expect(refreshed.timeline.find((e: { eventId: number }) => e.eventId === note.eventId).hidden).toBe(true);
    expect(refreshed.what_went_well).toBe("Alert fired within a minute.");
  });

  it("won't publish with the placeholder root cause", async () => {
    const sam = await resolvedIncident();
    const res = await api().put(PM).set(sam).send({ status: "published" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/root cause/);
  });

  it("freezes the narrative once published, but action items can still be ticked off", async () => {
    const sam = await resolvedIncident();
    const published = await api()
      .put(PM)
      .set(sam)
      .send({
        rootCause: "Connection pool exhausted after deploy 1.4.2 doubled queries per request",
        actionItems: [{ description: "Add DB connection alerts" }],
        status: "published",
      });
    expect(published.body.postmortem).toMatchObject({ status: "published", published_by_name: "Sam" });
    expect(published.body.postmortem.published_at).toBeTruthy();

    const edit = await api().put(PM).set(sam).send({ impact: "changed later" });
    expect(edit.status).toBe(409);

    const itemId = published.body.postmortem.action_items[0].id;
    const tick = await api().patch(`${PM}/action-items/${itemId}`).set(sam).send({ done: true, owner: "Jordan" });
    expect(tick.status).toBe(200);
    expect(tick.body.actionItem).toMatchObject({ id: itemId, done: true, owner: "Jordan" });
    expect((await api().patch(`${PM}/action-items/ai_missing1`).set(sam).send({ done: true })).status).toBe(404);

    // Reopening as a draft allows edits again.
    const reopened = await api().put(PM).set(sam).send({ impact: "Customers could not check out for 37 minutes.", status: "draft" });
    expect(reopened.body.postmortem).toMatchObject({ status: "draft", published_at: null });

    const { rows: timeline } = await t.deps.pool.query(`SELECT event_type FROM timeline_events WHERE event_type LIKE 'POSTMORTEM%' ORDER BY id`);
    expect(timeline.map((e) => e.event_type)).toEqual(["POSTMORTEM_GENERATED", "POSTMORTEM_PUBLISHED"]);
    const { rows: audit } = await t.deps.pool.query(`SELECT action FROM audit_log WHERE action LIKE 'postmortem.%' ORDER BY id`);
    expect(audit.map((a) => a.action)).toEqual(["postmortem.publish", "postmortem.action_item", "postmortem.reopen"]);
  });
});

describe("markdown export", () => {
  it("downloads the document, leaving hidden entries out", async () => {
    const sam = await resolvedIncident();
    const pm = (await api().get(PM).set(sam)).body.postmortem;
    const note = pm.timeline.find((e: { type: string }) => e.type === "NOTE_ADDED");
    await api()
      .put(PM)
      .set(sam)
      .send({ actionItems: [{ description: "Add DB connection alerts", owner: "Sam" }], hiddenTimelineEventIds: [note.eventId] })
      .expect(200);

    const res = await api().get(`${PM}/markdown`).set(sam);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="INC-1-postmortem.md"');
    expect(res.text).toMatch(/^# INC-1 Postmortem \(draft\)/);
    expect(res.text).toContain("| **Incident** | Checkout API unavailable |");
    expect(res.text).toContain("| **Severity** | SEV-1 |");
    expect(res.text).toContain("- [ ] Add DB connection alerts — Sam");
    expect(res.text).toContain("Acknowledged _(Sam)_");
    expect(res.text).not.toContain("Database connections appear exhausted");
    expect((await api().get(`${PM}/markdown`).set(await t.as("eve"))).status).toBe(404);
  });
});
