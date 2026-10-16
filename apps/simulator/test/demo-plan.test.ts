import { describe, expect, it } from "vitest";
import { PRODUCTION_INCIDENT, scenarioDurationSeconds, simulatedAlert } from "@irp/shared";
import { alertPayloadSchema } from "@irp/shared";
import { formatClock, parseArgs, planResponse } from "../src/demo-plan";

describe("the production-incident scenario", () => {
  it("tells the story in order: CPU, latency, failures, critical, database", () => {
    expect(PRODUCTION_INCIDENT.steps.map((s) => [s.at, s.label])).toEqual([
      [0, "CPU alert"],
      [3, "API latency alert"],
      [5, "Checkout failures"],
      [8, "Critical incident"],
      [12, "Database connection alert"],
      [15, "Failures keep coming"],
    ]);
    expect(scenarioDurationSeconds(PRODUCTION_INCIDENT)).toBe(15);
  });

  it("sends valid alert payloads, tagged as simulated", () => {
    for (const step of PRODUCTION_INCIDENT.steps) {
      const payload = alertPayloadSchema.parse(simulatedAlert(step, "run_1"));
      expect(payload.metadata).toMatchObject({ simulated: true, demoRun: "run_1" });
    }
  });

  it("escalates the checkout failures under one deduplication key", () => {
    const failures = PRODUCTION_INCIDENT.steps.filter((s) => s.alert.deduplicationKey === "checkout-errors");
    expect(failures.map((s) => s.alert.severity)).toEqual(["HIGH", "CRITICAL", "CRITICAL"]);
  });
});

describe("demo CLI", () => {
  it("parses --speed and --respond", () => {
    expect(parseArgs([])).toEqual({ speed: 1, respond: false });
    expect(parseArgs(["--speed", "5", "--respond"])).toEqual({ speed: 5, respond: true });
    expect(parseArgs(["--speed=2"])).toEqual({ speed: 2, respond: false });
    expect(() => parseArgs(["--speed", "0"])).toThrow(/--speed/);
    expect(() => parseArgs(["--fast"])).toThrow(/Unknown option/);
  });

  it("formats the clock as mm:ss", () => {
    expect([0, 8, 75, 600].map(formatClock)).toEqual(["00:00", "00:08", "01:15", "10:00"]);
  });

  it("plans the responders' lifecycle after the last alert", () => {
    const plan = planResponse(
      new Map([
        ["checkout-errors", 65],
        ["pg-connections", 66],
      ]),
      15
    );
    expect(plan.every((s) => s.at > 15)).toBe(true);
    expect(plan.map((s) => s.label)).toEqual([
      "acknowledges INC-65",
      "starts investigating",
      "runs the incident investigator",
      'notes "Database connections appear exhausted (500/500)"',
      "links INC-66: same root cause",
      'notes "Rolled back checkout-api to v2.13.4"',
      "marks it mitigated",
      "monitoring clears the alerts",
      "resolves INC-65",
      "resolves INC-66",
      "asks for an AI postmortem draft",
    ]);
    const ack = plan[0];
    expect(ack).toMatchObject({ kind: "api", method: "POST", path: "/incidents/65/acknowledge" });
    expect([...plan].sort((a, b) => a.at - b.at)).toEqual(plan);
  });

  it("does nothing for incidents that never opened", () => {
    expect(planResponse(new Map(), 15).map((s) => s.kind)).toEqual(["clear-alerts"]);
  });
});
