// Core vocabulary of the platform. Kept in one place so the API, worker and
// web app can't drift apart (the database CHECK constraints in
// packages/database/migrations mirror these lists).

// The alert API accepts these in any case ("CRITICAL", "critical") and
// stores them lower-case.
export const ALERT_SEVERITIES = ["critical", "high", "warning", "info"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ["triggered", "resolved", "suppressed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

// In lifecycle order; see lifecycle.ts for which moves are allowed.
export const INCIDENT_STATUSES = ["triggered", "acknowledged", "investigating", "mitigated", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const SERVICE_STATUSES = ["operational", "degraded", "outage", "maintenance"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const ROLES = ["admin", "responder"] as const;
export type Role = (typeof ROLES)[number];

// Higher number = more severe; used for "at least" comparisons.
export const ALERT_SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  high: 2,
  critical: 3,
};

export const INCIDENT_SEVERITY_RANK: Record<IncidentSeverity, number> = {
  sev4: 0,
  sev3: 1,
  sev2: 2,
  sev1: 3,
};

// Default incident severity for an incident opened by an alert, when the
// matching rule doesn't override it.
export const SEVERITY_FROM_ALERT: Record<AlertSeverity, IncidentSeverity> = {
  critical: "sev1",
  high: "sev2",
  warning: "sev3",
  info: "sev4",
};

export const INCIDENT_SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  sev1: "SEV1 · Critical",
  sev2: "SEV2 · Major",
  sev3: "SEV3 · Minor",
  sev4: "SEV4 · Low",
};

export function incidentRef(number: number) {
  return `INC-${number}`;
}

// The incident timeline is an append-only audit log (migration 0005): one
// event per important action, never edited or deleted. Metadata carries the
// details, e.g. STATUS_CHANGED { from: "triggered", to: "investigating" }.
export const TIMELINE_EVENT_TYPES = [
  "INCIDENT_CREATED",
  "ALERT_ATTACHED",
  "ALERT_RESOLVED",
  "NOTIFICATION_SENT", // a responder was paged (escalation level 1)
  "INCIDENT_ESCALATED", // a later escalation level was paged, automatically or by hand
  "INCIDENT_ACKNOWLEDGED",
  "STATUS_CHANGED",
  "SEVERITY_CHANGED",
  "RESPONDER_ADDED",
  "COMMANDER_ASSIGNED",
  "NOTE_ADDED",
  "INCIDENT_RESOLVED",
  "POSTMORTEM_GENERATED",
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];
