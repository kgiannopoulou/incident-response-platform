import type { IncidentSeverity, IncidentStatus, ServiceStatus } from "./domain";

// The incident state machine. Every status change — from a responder in the
// UI, from an alert auto-resolving, from the API — is checked against this
// table in the backend (and again by a trigger in the database, migration
// 0004), so an incident can't, say, jump from resolved back to acknowledged.
//
//   TRIGGERED ──► ACKNOWLEDGED ──► INVESTIGATING ──► MITIGATED ──► RESOLVED
//       │              │                 │                            ▲
//       └──────────────┴─────────────────┴────────────────────────────┘
//                      shortcuts straight to RESOLVED
//
// - Each step only moves forward; nothing goes back to TRIGGERED.
// - MITIGATED = customer impact has stopped (failover, rollback, feature
//   flag) but the cause isn't fixed yet. It's what time-to-mitigate and the
//   postmortem's impact window are measured against.
// - RESOLVED is final. If the problem comes back, the next alert opens a new
//   incident (correlation only joins *open* incidents), which keeps each
//   incident's timeline, metrics and postmortem honest.
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  triggered: ["acknowledged", "resolved"],
  acknowledged: ["investigating", "resolved"],
  investigating: ["mitigated", "resolved"],
  mitigated: ["resolved"],
  resolved: [],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus) {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: IncidentStatus) {
  return INCIDENT_TRANSITIONS[from];
}

export class InvalidTransitionError extends Error {
  constructor(
    public from: IncidentStatus,
    public to: IncidentStatus
  ) {
    const allowed = INCIDENT_TRANSITIONS[from];
    super(
      `Cannot move an incident from '${from}' to '${to}'` +
        (allowed.length ? ` (allowed: ${allowed.join(", ")})` : ` ('${from}' is final)`)
    );
  }

  get allowed() {
    return INCIDENT_TRANSITIONS[this.from];
  }
}

export function assertTransition(from: IncidentStatus, to: IncidentStatus) {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isOpen(status: IncidentStatus) {
  return status !== "resolved";
}

// Escalation stops as soon as somebody has taken ownership.
export function shouldEscalate(status: IncidentStatus) {
  return status === "triggered";
}

// A service's status is derived from its open incidents: any open SEV1
// means an outage, any open SEV2 means degraded. A mitigated incident's
// impact has stopped, so it counts as degraded at most (still being fixed,
// no longer down). Maintenance is a manual override that alerts don't change.
export function deriveServiceStatus(
  current: ServiceStatus,
  openIncidents: { severity: IncidentSeverity; status: IncidentStatus }[]
): ServiceStatus {
  if (current === "maintenance") return "maintenance";
  const severe = (i: { severity: IncidentSeverity }) => i.severity === "sev1" || i.severity === "sev2";
  if (openIncidents.some((i) => i.severity === "sev1" && i.status !== "mitigated")) return "outage";
  if (openIncidents.some(severe)) return "degraded";
  return "operational";
}
