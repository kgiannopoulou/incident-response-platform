import { describe, expect, it } from "vitest";
import { INCIDENT_STATUSES, type IncidentStatus } from "../src/domain";
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  deriveServiceStatus,
  InvalidTransitionError,
  shouldEscalate,
} from "../src/lifecycle";

describe("incident state machine", () => {
  it("allows the forward lifecycle triggered -> acknowledged -> investigating -> mitigated -> resolved", () => {
    expect(canTransition("triggered", "acknowledged")).toBe(true);
    expect(canTransition("acknowledged", "investigating")).toBe(true);
    expect(canTransition("investigating", "mitigated")).toBe(true);
    expect(canTransition("mitigated", "resolved")).toBe(true);
  });

  it("allows resolving straight from any open state", () => {
    for (const from of INCIDENT_STATUSES.filter((s) => s !== "resolved")) {
      expect(canTransition(from, "resolved")).toBe(true);
    }
  });

  it("never moves backwards, and resolved is final", () => {
    const order = INCIDENT_STATUSES;
    for (const from of order) {
      for (const to of order) {
        if (order.indexOf(to) <= order.indexOf(from)) expect(canTransition(from, to)).toBe(false);
      }
    }
    expect(allowedTransitions("resolved")).toEqual([]);
  });

  it("doesn't skip steps other than the shortcut to resolved", () => {
    expect(canTransition("triggered", "investigating")).toBe(false);
    expect(canTransition("triggered", "mitigated")).toBe(false);
    expect(canTransition("acknowledged", "mitigated")).toBe(false);
  });

  it("explains rejected transitions", () => {
    expect(() => assertTransition("resolved", "acknowledged")).toThrow(
      "Cannot move an incident from 'resolved' to 'acknowledged' ('resolved' is final)"
    );
    const err = (() => {
      try {
        assertTransition("triggered", "mitigated");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect((err as InvalidTransitionError).allowed).toEqual(["acknowledged", "resolved"]);
  });

  it("only escalates unacknowledged incidents", () => {
    expect(shouldEscalate("triggered")).toBe(true);
    for (const s of INCIDENT_STATUSES.filter((s) => s !== "triggered")) expect(shouldEscalate(s)).toBe(false);
  });
});

describe("deriveServiceStatus", () => {
  const open = (severity: "sev1" | "sev2" | "sev3" | "sev4", status: IncidentStatus = "investigating") => ({
    severity,
    status,
  });

  it("derives status from the worst open incident", () => {
    expect(deriveServiceStatus("operational", [open("sev3"), open("sev1")])).toBe("outage");
    expect(deriveServiceStatus("outage", [open("sev2")])).toBe("degraded");
    expect(deriveServiceStatus("degraded", [open("sev4")])).toBe("operational");
    expect(deriveServiceStatus("outage", [])).toBe("operational");
  });

  it("treats a mitigated SEV1 as degraded, not down", () => {
    expect(deriveServiceStatus("outage", [open("sev1", "mitigated")])).toBe("degraded");
    expect(deriveServiceStatus("outage", [open("sev1", "mitigated"), open("sev1", "triggered")])).toBe("outage");
  });

  it("keeps maintenance as a manual override", () => {
    expect(deriveServiceStatus("maintenance", [open("sev1")])).toBe("maintenance");
  });
});
