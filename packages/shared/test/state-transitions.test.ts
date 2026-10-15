import { describe, expect, it } from "vitest";
import { INCIDENT_STATUSES, type IncidentStatus } from "../src/domain";
import { assertTransition, canTransition, InvalidTransitionError } from "../src/lifecycle";

// Phase 20: the state machine as a table, plus random walks.
//
//   triggered → acknowledged      ✓
//   acknowledged → investigating  ✓
//   investigating → resolved      ✓
//   resolved → investigating      ✗

describe("state transitions (the plan's table)", () => {
  it.each([
    ["triggered", "acknowledged", true],
    ["acknowledged", "investigating", true],
    ["investigating", "resolved", true],
    ["resolved", "investigating", false],
  ] as [IncidentStatus, IncidentStatus, boolean][])("%s → %s: %s", (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
    if (allowed) expect(() => assertTransition(from, to)).not.toThrow();
    else expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it("matches the full 5 × 5 matrix", () => {
    const matrix = INCIDENT_STATUSES.map((from) => INCIDENT_STATUSES.map((to) => (canTransition(from, to) ? "✓" : "·")).join(" "));
    // columns: triggered acknowledged investigating mitigated resolved
    expect(matrix).toEqual([
      "· ✓ · · ✓", // triggered
      "· · ✓ · ✓", // acknowledged
      "· · · ✓ ✓", // investigating
      "· · · · ✓", // mitigated
      "· · · · ·", // resolved
    ]);
  });
});

describe("random walks through the state machine", () => {
  // Deterministic PRNG so a failure is reproducible.
  function rng(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  }

  it("never reaches an invalid state, never moves backwards, and always ends in resolved", () => {
    const order = (s: IncidentStatus) => INCIDENT_STATUSES.indexOf(s);
    const rand = rng(42);
    for (let walk = 0; walk < 2000; walk++) {
      let state: IncidentStatus = "triggered";
      for (let step = 0; step < 20; step++) {
        const target = INCIDENT_STATUSES[Math.floor(rand() * INCIDENT_STATUSES.length)];
        let accepted = true;
        try {
          assertTransition(state, target);
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidTransitionError);
          accepted = false;
        }
        if (accepted) {
          expect(order(target)).toBeGreaterThan(order(state)); // forward only
          state = target;
        }
      }
      // From wherever the walk stopped, resolving is always possible (unless already resolved) …
      if (state !== "resolved") expect(canTransition(state, "resolved")).toBe(true);
      // … and resolved is absorbing.
      expect(INCIDENT_STATUSES.some((s) => canTransition("resolved", s))).toBe(false);
    }
  });
});
