import {
  ALERT_SEVERITIES,
  ALERT_SEVERITY_RANK,
  SEVERITY_FROM_ALERT,
  type AlertSeverity,
  type IncidentSeverity,
} from "./domain";
import type { RuleCondition } from "./schemas";

// Decides what happens to an incoming alert. Rules are evaluated in order
// and the first one whose conditions all match wins; an empty condition list
// matches everything. Pure function, so it's unit tested without a database.

export type AlertForMatching = {
  severity: AlertSeverity;
  source: string;
  title: string;
  description?: string | null;
};

export type AlertRule = {
  id: number;
  name: string;
  conditions: RuleCondition[];
  action: "create_incident" | "suppress";
  incidentSeverity?: IncidentSeverity | null;
};

export type RuleDecision =
  | { action: "create_incident"; severity: IncidentSeverity; ruleId: number | null; reason: string }
  | { action: "record_only"; ruleId: null; reason: string }
  | { action: "suppress"; ruleId: number; reason: string };

function conditionMatches(alert: AlertForMatching, condition: RuleCondition) {
  if (condition.field === "severity") {
    const wanted = condition.value as AlertSeverity;
    if (!ALERT_SEVERITIES.includes(wanted)) return false;
    if (condition.op === "at_least") {
      return ALERT_SEVERITY_RANK[alert.severity] >= ALERT_SEVERITY_RANK[wanted];
    }
    if (condition.op === "equals") return alert.severity === wanted;
    return false;
  }

  const actual = (alert[condition.field] ?? "").toLowerCase();
  const value = condition.value.toLowerCase();
  if (condition.op === "equals") return actual === value;
  if (condition.op === "contains") return actual.includes(value);
  return false; // at_least only makes sense for severity
}

export function evaluateRules(alert: AlertForMatching, rules: AlertRule[]): RuleDecision {
  for (const rule of rules) {
    if (!rule.conditions.every((c) => conditionMatches(alert, c))) continue;
    if (rule.action === "suppress") {
      return { action: "suppress", ruleId: rule.id, reason: `Suppressed by rule "${rule.name}"` };
    }
    return {
      action: "create_incident",
      severity: rule.incidentSeverity ?? SEVERITY_FROM_ALERT[alert.severity],
      ruleId: rule.id,
      reason: `Matched rule "${rule.name}"`,
    };
  }

  // Default rule: page for critical and high alerts, only record the rest.
  if (ALERT_SEVERITY_RANK[alert.severity] >= ALERT_SEVERITY_RANK.high) {
    return {
      action: "create_incident",
      severity: SEVERITY_FROM_ALERT[alert.severity],
      ruleId: null,
      reason: "Default rule: critical/high alerts open an incident",
    };
  }
  return {
    action: "record_only",
    ruleId: null,
    reason: "Default rule: warning/info alerts are recorded without paging",
  };
}
