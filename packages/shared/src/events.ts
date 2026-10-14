import type { IncidentSeverity, IncidentStatus } from "./domain";

// Messages pushed to browsers over Server-Sent Events. The API and the
// worker publish them through Redis (see realtime.ts); every API process
// relays them to its connected clients. They are deliberately small
// "something changed" hints — clients re-fetch the affected resource rather
// than trusting the payload as the source of truth. Incident events also
// carry the new status/severity, so an open page can show the change the
// instant it arrives (Browser B flips TRIGGERED -> ACKNOWLEDGED while the
// re-fetch is still in flight), and who made it.
//
// Delivery is at-least-once: after a reconnect the server replays from the
// browser's Last-Event-ID, so a hint may arrive twice, which is harmless
// for a re-fetch.

type IncidentHint = {
  incidentId: number;
  number: number;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  actor?: string; // who changed it, when a person did
};

export type RealtimeEvent =
  | ({ type: "incident.created" } & IncidentHint)
  | ({ type: "incident.updated" } & IncidentHint)
  | { type: "timeline.added"; incidentId: number }
  | { type: "service.updated"; serviceId: number }
  | { type: "alert.received"; alertId: number; serviceId: number };

// Control messages on the stream that aren't about a resource.
//   connected — the stream is open
//   resync    — the server can't replay what this client missed (too old,
//               or unknown id): re-fetch everything
export type StreamControlEvent = { type: "connected" } | { type: "resync" };

export const orgChannel = (organizationId: number) => `irp:events:org:${organizationId}`;
export const orgStream = (organizationId: number) => `irp:stream:org:${organizationId}`;
