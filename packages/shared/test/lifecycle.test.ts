import { describe, expect, it } from "vitest";
import { INCIDENT_STATUSES } from "../src/domain";
import {
  assertTransition,
  canTransition,
  deriveServiceStatus,
  InvalidTransitionError,
  shouldEscalate,
} from "../src/lifecycle";

describe("incident state machine", () => {
  it("allows the normal lifecycle and reopening", () => {
    expect(canTransition("triggered", "acknowledged")).toBe(true);
    expect(canTransition("acknowledged", "investigating")).toBe(true);
    expect(canTransition("investigating", "resolved")).toBe(true);
    expect(canTransition("resolved", "investigating")).toBe(true);
  });

  it("never goes back to triggered or acknowledged", () => {
    for (const from of INCIDENT_STATUSES) {
      expect(canTransition(from, "triggered")).toBe(false);
      if (from !== "triggered") expect(canTransition(from, "acknowledged")).toBe(false);
    }
  });

  it("rejects no-op transitions", () => {
    for (const s of INCIDENT_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(() => assertTransition("resolved", "resolved")).toThrow(InvalidTransitionError);
  });

  it("only escalates unacknowledged incidents", () => {
    expect(shouldEscalate("triggered")).toBe(true);
    expect(shouldEscalate("acknowledged")).toBe(false);
    expect(shouldEscalate("resolved")).toBe(false);
  });
});

describe("deriveServiceStatus", () => {
  it("derives status from the worst open incident", () => {
    expect(deriveServiceStatus("operational", ["sev3", "sev1"])).toBe("outage");
    expect(deriveServiceStatus("outage", ["sev2"])).toBe("degraded");
    expect(deriveServiceStatus("degraded", ["sev4"])).toBe("operational");
    expect(deriveServiceStatus("outage", [])).toBe("operational");
  });

  it("keeps maintenance as a manual override", () => {
    expect(deriveServiceStatus("maintenance", ["sev1"])).toBe("maintenance");
  });
});
