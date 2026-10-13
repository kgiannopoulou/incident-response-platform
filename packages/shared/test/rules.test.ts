import { describe, expect, it } from "vitest";
import { evaluateRules, type AlertRule } from "../src/rules";

const alert = (overrides = {}) => ({
  severity: "error" as const,
  source: "prometheus:checkout-5xx",
  summary: "Checkout API 5xx rate above 5%",
  component: "checkout-api",
  ...overrides,
});

describe("evaluateRules", () => {
  it("defaults: critical/error open incidents with mapped severity", () => {
    expect(evaluateRules(alert({ severity: "critical" }), [])).toMatchObject({
      action: "create_incident",
      severity: "sev1",
      ruleId: null,
    });
    expect(evaluateRules(alert(), [])).toMatchObject({ action: "create_incident", severity: "sev2" });
  });

  it("defaults: warning/info are recorded only", () => {
    expect(evaluateRules(alert({ severity: "warning" }), []).action).toBe("record_only");
    expect(evaluateRules(alert({ severity: "info" }), []).action).toBe("record_only");
  });

  it("first matching rule wins and can override severity", () => {
    const rules: AlertRule[] = [
      {
        id: 1,
        name: "Ignore staging",
        conditions: [{ field: "source", op: "contains", value: "staging" }],
        action: "suppress",
      },
      {
        id: 2,
        name: "Page on latency warnings",
        conditions: [
          { field: "summary", op: "contains", value: "LATENCY" },
          { field: "severity", op: "at_least", value: "warning" },
        ],
        action: "create_incident",
        incidentSeverity: "sev2",
      },
    ];
    expect(evaluateRules(alert({ source: "staging-probe" }), rules)).toMatchObject({
      action: "suppress",
      ruleId: 1,
    });
    expect(evaluateRules(alert({ severity: "warning", summary: "p99 latency high" }), rules)).toMatchObject({
      action: "create_incident",
      severity: "sev2",
      ruleId: 2,
    });
    // info is below "at_least warning", so it falls through to the default rule
    expect(evaluateRules(alert({ severity: "info", summary: "latency" }), rules).action).toBe("record_only");
  });

  it("an empty condition list matches everything", () => {
    const rules: AlertRule[] = [{ id: 9, name: "Catch-all", conditions: [], action: "create_incident" }];
    expect(evaluateRules(alert({ severity: "info" }), rules)).toMatchObject({ ruleId: 9, severity: "sev4" });
  });

  it("ignores at_least on non-severity fields and unknown severities", () => {
    const rules: AlertRule[] = [
      { id: 1, name: "bad", conditions: [{ field: "source", op: "at_least", value: "x" }], action: "suppress" },
      { id: 2, name: "bad2", conditions: [{ field: "severity", op: "at_least", value: "nope" }], action: "suppress" },
    ];
    expect(evaluateRules(alert(), rules).action).toBe("create_incident");
  });
});
