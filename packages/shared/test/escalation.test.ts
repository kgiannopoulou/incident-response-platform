import { describe, expect, it } from "vitest";
import {
  ackTimeoutMinutesFor,
  describeEscalationDelay,
  escalationDueAt,
  escalationPolicySchema,
  isHighUrgency,
  nextEscalationStep,
} from "../src/escalation";

const team = (id: number) => ({ targetType: "team" as const, targetId: id });
const user = (id: number) => ({ targetType: "user" as const, targetId: id });

describe("escalationPolicySchema", () => {
  it("accepts the 0 / 5 / 10 minute policy", () => {
    const policy = escalationPolicySchema.parse({
      name: "Checkout escalation",
      steps: [
        { delayMinutes: 0, targets: [team(1)] },
        { delayMinutes: 5, targets: [user(2)] },
        { delayMinutes: 10, targets: [user(3), team(4)] },
      ],
    });
    expect(policy.description).toBe("");
    expect(policy.steps).toHaveLength(3);
  });

  it("requires steps in strictly increasing time order", () => {
    const result = escalationPolicySchema.safeParse({
      name: "Backwards",
      steps: [
        { delayMinutes: 5, targets: [user(1)] },
        { delayMinutes: 5, targets: [user(2)] },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]).toMatchObject({ path: ["steps", 1, "delayMinutes"] });
    expect(result.error!.issues[0].message).toMatch(/later than step 1/);
  });

  it("rejects empty policies, steps without targets and duplicate targets", () => {
    expect(escalationPolicySchema.safeParse({ name: "Empty", steps: [] }).success).toBe(false);
    expect(escalationPolicySchema.safeParse({ name: "No one", steps: [{ delayMinutes: 0, targets: [] }] }).success).toBe(false);
    const dup = escalationPolicySchema.safeParse({ name: "Dup", steps: [{ delayMinutes: 0, targets: [user(1), user(1)] }] });
    expect(dup.success).toBe(false);
    expect(dup.error!.issues[0].message).toBe("duplicate target in this step");
    // Same id, different type, is not a duplicate.
    expect(escalationPolicySchema.safeParse({ name: "Ok", steps: [{ delayMinutes: 0, targets: [user(1), team(1)] }] }).success).toBe(true);
  });

  it("caps delays at one day", () => {
    expect(escalationPolicySchema.safeParse({ name: "Slow", steps: [{ delayMinutes: 1441, targets: [user(1)] }] }).success).toBe(false);
  });
});

describe("scheduling", () => {
  const steps = [
    { position: 1, delayMinutes: 0 },
    { position: 3, delayMinutes: 10 },
    { position: 2, delayMinutes: 5 },
  ];

  it("finds the step after the current level, in position order", () => {
    expect(nextEscalationStep(steps, 0)).toEqual({ position: 1, delayMinutes: 0 });
    expect(nextEscalationStep(steps, 1)).toEqual({ position: 2, delayMinutes: 5 });
    expect(nextEscalationStep(steps, 3)).toBeNull();
  });

  it("anchors due times to the trigger time, never in the past", () => {
    const triggered = new Date("2026-10-14T14:00:00Z");
    expect(escalationDueAt(triggered, { position: 2, delayMinutes: 5 }, triggered)).toEqual(new Date("2026-10-14T14:05:00Z"));
    const late = new Date("2026-10-14T14:07:00Z");
    expect(escalationDueAt(triggered, { position: 2, delayMinutes: 5 }, late)).toEqual(late);
  });

  it("describes delays the way the policy page reads", () => {
    expect(describeEscalationDelay(0)).toBe("Immediately");
    expect(describeEscalationDelay(5)).toBe("5 min without acknowledgement");
    expect(describeEscalationDelay(90)).toBe("1 h 30 min without acknowledgement");
  });
});

describe("acknowledgement timeout", () => {
  it("applies only to high-urgency incidents of a policy that has one", () => {
    expect(isHighUrgency("sev1")).toBe(true);
    expect(isHighUrgency("sev2")).toBe(true);
    expect(isHighUrgency("sev3")).toBe(false);
    expect(ackTimeoutMinutesFor("sev1", 5)).toBe(5);
    expect(ackTimeoutMinutesFor("sev4", 5)).toBeNull();
    expect(ackTimeoutMinutesFor("sev1", null)).toBeNull();
  });

  it("is optional on a policy and bounded", () => {
    const base = { name: "On-call", steps: [{ delayMinutes: 0, targets: [user(1)] }] };
    expect(escalationPolicySchema.parse(base).ackTimeoutMinutes).toBeNull();
    expect(escalationPolicySchema.parse({ ...base, ackTimeoutMinutes: 5 }).ackTimeoutMinutes).toBe(5);
    expect(escalationPolicySchema.safeParse({ ...base, ackTimeoutMinutes: 0 }).success).toBe(false);
  });
});
