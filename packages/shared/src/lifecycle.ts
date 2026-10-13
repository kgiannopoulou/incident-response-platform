import type { IncidentSeverity, IncidentStatus, ServiceStatus } from "./domain";

// The incident state machine. Every status change — from a responder in the
// UI, from an alert auto-resolving, from the API — is checked against this
// table, so an incident can't, say, jump from resolved back to acknowledged.
//
//   triggered ──► acknowledged ──► investigating ──► resolved
//       │              │                                ▲  │
//       └──────────────┴────────────────────────────────┘  │
//                         reopen: resolved ──► investigating
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  triggered: ["acknowledged", "investigating", "resolved"],
  acknowledged: ["investigating", "resolved"],
  investigating: ["resolved"],
  resolved: ["investigating"],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus) {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public from: IncidentStatus,
    public to: IncidentStatus
  ) {
    super(`Cannot move an incident from '${from}' to '${to}'`);
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
// means an outage, any open SEV2 means degraded. Maintenance is a manual
// override that alerts don't change.
export function deriveServiceStatus(
  current: ServiceStatus,
  openIncidentSeverities: IncidentSeverity[]
): ServiceStatus {
  if (current === "maintenance") return "maintenance";
  if (openIncidentSeverities.includes("sev1")) return "outage";
  if (openIncidentSeverities.includes("sev2")) return "degraded";
  return "operational";
}
