import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAiPostmortemContext } from "@irp/database";
import { TEST_KEYS } from "@irp/database/testing";
import { checkAiDraft, ruleBasedPostmortemDraft, UNCONFIRMED_ROOT_CAUSE } from "@irp/shared";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const api = () => request(t.app);
const PM = "/api/v1/incidents/1/postmortem";

async function resolvedIncident() {
  await t.alert(TEST_KEYS.checkout, { title: "Checkout API unavailable", severity: "critical", source: "prometheus", deduplicationKey: "checkout-5xx" });
  const sam = await t.as("sam");
  await api().post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
  await api().post("/api/v1/incidents/1/notes").set(sam).send({ message: "Database connections appear exhausted" }).expect(201);
  await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved", message: "Pool size raised" }).expect(200);
  return sam;
}

// What the worker would do with the job, using the offline drafter.
async function finishDraft(draftId: number) {
  const { rows } = await t.deps.pool.query(`SELECT incident_id FROM postmortem_ai_drafts WHERE id = $1`, [draftId]);
  const context = (await loadAiPostmortemContext(t.deps.pool, rows[0].incident_id))!;
  const { draft, warnings } = checkAiDraft(ruleBasedPostmortemDraft(context), context);
  await t.deps.pool.query(
    `UPDATE postmortem_ai_drafts SET status = 'ready', provider = 'rules', output = $2, warnings = $3, completed_at = now() WHERE id = $1`,
    [draftId, JSON.stringify(draft), JSON.stringify(warnings)]
  );
}

async function readyDraft(sam: Record<string, string>) {
  const { body } = await api().post(`${PM}/ai-drafts`).set(sam).expect(202);
  await finishDraft(body.draft.id);
  return body.draft.id as number;
}

describe("requesting an AI draft", () => {
  it("queues a worker job for resolved incidents only", async () => {
    await t.alert(TEST_KEYS.checkout, { title: "Checkout down", severity: "critical", source: "probe" });
    const sam = await t.as("sam");
    expect((await api().post(`${PM}/ai-drafts`).set(sam)).status).toBe(409); // still open

    await api().post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);
    const { body } = await api().post(`${PM}/ai-drafts`).set(sam).expect(202);
    expect(body.draft).toMatchObject({ status: "queued" });

    const job = await t.deps.queues.aiDrafts.getJob(`ai-draft-${body.draft.id}`);
    expect(job?.data).toEqual({ draftId: body.draft.id });
    expect(job?.opts.attempts).toBe(3);
  });

  it("allows one generation at a time per incident", async () => {
    const sam = await resolvedIncident();
    await api().post(`${PM}/ai-drafts`).set(sam).expect(202);
    const second = await api().post(`${PM}/ai-drafts`).set(sam);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already being generated/);
  });

  it("lists drafts with their validation warnings and is tenant-isolated", async () => {
    const sam = await resolvedIncident();
    await readyDraft(sam);
    const { body } = await api().get(`${PM}/ai-drafts`).set(sam).expect(200);
    expect(body.drafts[0]).toMatchObject({ status: "ready", provider: "rules", requested_by_name: "Sam", warnings: expect.any(Array) });
    expect(body.drafts[0].output.probableRootCause.statement).toContain("Database connections appear exhausted");

    const eve = await t.as("eve");
    expect((await api().get(`${PM}/ai-drafts`).set(eve)).body.drafts).toEqual([]);
    expect((await api().post(`${PM}/ai-drafts`).set(eve)).status).toBe(404);
    expect((await api().post(`${PM}/ai-drafts/1/apply`).set(eve).send({ sections: ["summary"] })).status).toBe(404);
  });
});

describe("reviewing and applying a draft", () => {
  it("copies only the chosen sections and never touches the timeline or metrics", async () => {
    const sam = await resolvedIncident();
    const before = (await api().get(PM).set(sam)).body.postmortem;
    const draftId = await readyDraft(sam);

    const { body } = await api().post(`${PM}/ai-drafts/${draftId}/apply`).set(sam).send({ sections: ["summary", "rootCause", "actionItems"] }).expect(200);
    const pm = body.postmortem;
    expect(pm.summary).toMatch(/^INC-1 \(SEV1/);
    expect(pm.root_cause.startsWith(UNCONFIRMED_ROOT_CAUSE)).toBe(true);
    expect(pm.impact).toBe(before.impact); // not chosen
    expect(pm.timeline).toEqual(before.timeline);
    expect(pm.metrics).toEqual(before.metrics);
    expect(pm.action_items.length).toBeGreaterThan(before.action_items.length);
    expect(pm.action_items.slice(0, before.action_items.length)).toEqual(before.action_items); // appended, not replaced
    expect(pm).toMatchObject({ ai_assisted_sections: ["summary", "rootCause", "actionItems"], ai_review_pending: true });

    const { rows } = await t.deps.pool.query(`SELECT status, applied_sections FROM postmortem_ai_drafts WHERE id = $1`, [draftId]);
    expect(rows[0]).toEqual({ status: "applied", applied_sections: ["summary", "rootCause", "actionItems"] });
    const { rows: audit } = await t.deps.pool.query(`SELECT details FROM audit_log WHERE action = 'postmortem.ai_draft_applied'`);
    expect(audit[0].details).toEqual({ draftId, sections: ["summary", "rootCause", "actionItems"] });
  });

  it("refuses drafts that aren't ready, unknown sections and published postmortems", async () => {
    const sam = await resolvedIncident();
    const { body } = await api().post(`${PM}/ai-drafts`).set(sam).expect(202);
    expect((await api().post(`${PM}/ai-drafts/${body.draft.id}/apply`).set(sam).send({ sections: ["summary"] })).status).toBe(409);
    await finishDraft(body.draft.id);
    expect((await api().post(`${PM}/ai-drafts/${body.draft.id}/apply`).set(sam).send({ sections: ["timeline"] })).status).toBe(400);

    await api().put(PM).set(sam).send({ rootCause: "Pool too small for peak traffic", status: "published" }).expect(200);
    const res = await api().post(`${PM}/ai-drafts/${body.draft.id}/apply`).set(sam).send({ sections: ["summary"] });
    expect(res.status).toBe(409);
    expect((await api().post(`${PM}/ai-drafts`).set(sam)).status).toBe(409);
  });

  it("can be discarded", async () => {
    const sam = await resolvedIncident();
    const draftId = await readyDraft(sam);
    await api().post(`${PM}/ai-drafts/${draftId}/discard`).set(sam).expect(204);
    expect((await api().post(`${PM}/ai-drafts/${draftId}/apply`).set(sam).send({ sections: ["summary"] })).status).toBe(409);
  });
});

describe("publishing an AI-assisted postmortem", () => {
  it("requires a confirmed review and a root cause a person has verified", async () => {
    const sam = await resolvedIncident();
    const draftId = await readyDraft(sam);
    await api().post(`${PM}/ai-drafts/${draftId}/apply`).set(sam).send({ sections: ["summary", "rootCause"] }).expect(200);

    // 1. Not reviewed yet.
    const unreviewed = await api().put(PM).set(sam).send({ status: "published" });
    expect(unreviewed.status).toBe(422);
    expect(unreviewed.body.error).toMatch(/Review the AI-drafted sections/);

    // 2. Reviewed, but the hypothesis marker is still in the root cause.
    const unconfirmed = await api().put(PM).set(sam).send({ status: "published", aiReviewed: true });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.body.error).toMatch(/unconfirmed AI hypothesis/);

    // 3. A person rewrote the cause and confirmed the review.
    const ok = await api()
      .put(PM)
      .set(sam)
      .send({ rootCause: "Checkout's DB pool (20) was too small for the 2x Friday peak.", aiReviewed: true, status: "published" })
      .expect(200);
    expect(ok.body.postmortem).toMatchObject({ status: "published", ai_review_pending: false, ai_reviewed_by_name: "Sam" });

    const md = await api().get(`${PM}/markdown`).set(sam).expect(200);
    expect(md.text).toContain("_Drafted with AI assistance (summary, rootCause); reviewed by Sam._");
  });

  it("asks for a fresh review after more AI sections are applied", async () => {
    const sam = await resolvedIncident();
    const draftId = await readyDraft(sam);
    await api().post(`${PM}/ai-drafts/${draftId}/apply`).set(sam).send({ sections: ["summary"] }).expect(200);
    await api().put(PM).set(sam).send({ aiReviewed: true }).expect(200);
    await api().post(`${PM}/ai-drafts/${draftId}/apply`).set(sam).send({ sections: ["impact"] }).expect(200);
    const { body } = await api().get(PM).set(sam);
    expect(body.postmortem).toMatchObject({ ai_review_pending: true, ai_assisted_sections: ["summary", "impact"] });
  });

  it("leaves postmortems written without AI unaffected", async () => {
    const sam = await resolvedIncident();
    await api().put(PM).set(sam).send({ rootCause: "Pool too small", status: "published" }).expect(200);
    const md = await api().get(`${PM}/markdown`).set(sam);
    expect(md.text).not.toContain("AI assistance");
  });
});
