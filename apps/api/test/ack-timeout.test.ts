import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { ackTimeoutJobId } from "@irp/shared";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  // The fixture policy gets a 5-minute acknowledgement timeout.
  await t.deps.pool.query(`UPDATE escalation_policies SET ack_timeout_minutes = 5`);
});

const api = () => request(t.app);
const alert = (severity: string, title = "Checkout down") => t.alert(TEST_KEYS.checkout, { title, severity, source: "probe", deduplicationKey: "checkout" });
const incident = async () => (await t.deps.pool.query(`SELECT * FROM incidents WHERE number = 1`)).rows[0];
const ackJob = () => t.deps.queues.escalations.getJob(ackTimeoutJobId(1));

describe("acknowledgement timeout", () => {
  it("arms a deadline and a delayed job when a critical incident opens", async () => {
    await alert("critical");
    const row = await incident();
    expect(row.ack_deadline_at.getTime() - row.triggered_at.getTime()).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(row.ack_deadline_at.getTime() - row.triggered_at.getTime()).toBeLessThanOrEqual(5 * 60_000 + 1000);

    const job = await ackJob();
    expect(job?.name).toBe("ack-timeout");
    expect(job?.data).toEqual({ incidentId: row.id });
    expect(job?.opts.delay).toBeGreaterThan(4 * 60_000);
    expect(await t.deps.queues.escalations.getJobCounts("delayed")).toMatchObject({ delayed: 1 });
  });

  it("doesn't apply to low-urgency incidents or policies without a timeout", async () => {
    await api()
      .post("/api/v1/incidents")
      .set(await t.as("sam"))
      .send({ title: "Slow checkout", severity: "sev3", serviceId: t.fx.services.checkout })
      .expect(201);
    expect((await incident()).ack_deadline_at).toBeNull();
    expect(await ackJob()).toBeUndefined();

    await t.deps.pool.query(`UPDATE escalation_policies SET ack_timeout_minutes = NULL`);
    await alert("critical", "Payments down");
    const { rows } = await t.deps.pool.query(`SELECT ack_deadline_at FROM incidents WHERE number = 2`);
    expect(rows[0].ack_deadline_at).toBeNull();
  });

  it("acknowledging in time clears the deadline and cancels the delayed job", async () => {
    await alert("critical");
    expect(await ackJob()).toBeTruthy();
    await api().post("/api/v1/incidents/1/acknowledge").set(await t.as("sam")).expect(200);
    expect((await incident()).ack_deadline_at).toBeNull();
    expect(await ackJob()).toBeUndefined();
  });

  it("starts the clock when the severity is raised to SEV1, and stops it when lowered", async () => {
    const sam = await t.as("sam");
    await api().post("/api/v1/incidents").set(sam).send({ title: "Slow checkout", severity: "sev3", serviceId: t.fx.services.checkout });
    expect((await incident()).ack_deadline_at).toBeNull();

    await api().post("/api/v1/incidents/1/severity").set(sam).send({ severity: "sev1" }).expect(200);
    expect((await incident()).ack_deadline_at).not.toBeNull();
    expect(await ackJob()).toBeTruthy();

    await api().post("/api/v1/incidents/1/severity").set(sam).send({ severity: "sev4" }).expect(200);
    expect((await incident()).ack_deadline_at).toBeNull();
    expect(await ackJob()).toBeUndefined();
  });

  it("treats SEV2 (opened by a HIGH alert) as high urgency too", async () => {
    await t.alert(TEST_KEYS.checkout, { title: "Checkout errors", severity: "high", source: "probe", deduplicationKey: "errs" });
    const sev2 = await incident();
    expect(sev2.severity).toBe("sev2");
    expect(sev2.ack_deadline_at).not.toBeNull();
  });

  it("reports missed acknowledgement timeouts on the dashboard", async () => {
    await alert("critical");
    await t.deps.pool.query(`UPDATE incidents SET ack_timed_out_at = now(), ack_deadline_at = NULL`);
    const res = await api().get("/api/v1/stats").set(await t.as("sam"));
    expect(res.body.stats.ack_timeouts_30d).toBe(1);
  });

  it("exposes the policy's timeout through the escalation policy API", async () => {
    const res = await api().get("/api/v1/escalation-policies").set(await t.as("alex"));
    expect(res.body.policies[0].ackTimeoutMinutes).toBe(5);
  });
});
