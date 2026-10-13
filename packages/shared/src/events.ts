// Messages pushed to browsers over Server-Sent Events. The API and the
// worker publish them to Redis (channel per organization); every API
// process relays them to its connected clients. They are deliberately small
// "something changed" hints — clients re-fetch the affected resource rather
// than trusting the event payload as the source of truth.

export type RealtimeEvent =
  | { type: "incident.created"; incidentId: number; number: number }
  | { type: "incident.updated"; incidentId: number; number: number }
  | { type: "timeline.added"; incidentId: number }
  | { type: "service.updated"; serviceId: number }
  | { type: "alert.received"; alertId: number; serviceId: number };

export const orgChannel = (organizationId: number) => `irp:events:org:${organizationId}`;
