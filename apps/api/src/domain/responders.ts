import type { PoolClient } from "@irp/database";
import { RESPONDER_ROLE_LABEL, type ResponderRole, type TimelineEventType } from "@irp/shared";
import { audit } from "../lib/audit";
import type { Effects } from "../lib/effects";
import { HttpError } from "../lib/http";
import { addTimeline, type IncidentRow } from "./incidents";

// Who is working an incident, and in what capacity:
//
//   Incident Commander — one per incident; coordinates and owns decisions
//   Responder          — works the problem
//   Observer           — follows along (support, management); read-only
//
// Rules:
// - Anyone in the organization can join themselves, as responder or
//   observer, and switch between the two or leave.
// - Changing someone else's role, removing them, or handing over command
//   when there already is a commander takes the current commander or an
//   org admin. Anyone may take command of an incident that has none.
// - The commander can't step down or leave without handing over first, so
//   an open incident never silently loses its commander.
// - Observers can't change the incident (status, severity, escalation,
//   notes) until they join as a responder.

export type RoleActor = { id: number; name: string; isAdmin: boolean };
type Person = { id: number; name: string };

export async function responderRole(db: PoolClient, incidentId: number, userId: number) {
  const { rows } = await db.query<{ role: ResponderRole }>(
    `SELECT role FROM incident_responders WHERE incident_id = $1 AND user_id = $2`,
    [incidentId, userId]
  );
  return rows[0]?.role ?? null;
}

// Guard for every action that changes the incident.
export async function assertCanAct(db: PoolClient, incident: IncidentRow, actor: { id: number }) {
  if ((await responderRole(db, incident.id, actor.id)) === "observer") {
    throw new HttpError(403, "Observers can't change the incident. Join as a responder first.");
  }
}

function assertOpen(incident: IncidentRow) {
  if (incident.status === "resolved") throw new HttpError(409, "Resolved incidents are final; responders can't change");
}

async function canLead(db: PoolClient, incident: IncidentRow, actor: RoleActor) {
  return actor.isAdmin || (await responderRole(db, incident.id, actor.id)) === "commander";
}

// Adds a person with a role, or changes their role. Returns false when
// nothing changed (they already had that role).
export async function setResponderRole(
  db: PoolClient,
  fx: Effects,
  incident: IncidentRow,
  target: Person,
  role: ResponderRole,
  actor: RoleActor
) {
  assertOpen(incident);
  const self = target.id === actor.id;
  const current = await responderRole(db, incident.id, target.id);
  if (current === role) return false;

  const lead = await canLead(db, incident, actor);
  if (!self && !lead) {
    throw new HttpError(403, "Only the incident commander or an admin can change other people's roles");
  }
  if (role === "commander" && incident.commander_id !== null && !lead) {
    throw new HttpError(403, "Only the current commander or an admin can hand over command");
  }
  if (current === "commander") {
    throw new HttpError(409, "Hand over command to someone else first");
  }

  if (role === "commander") {
    // Demote first: the partial unique index allows one commander per incident.
    await db.query(`UPDATE incident_responders SET role = 'responder' WHERE incident_id = $1 AND role = 'commander'`, [
      incident.id,
    ]);
    await db.query(`UPDATE incidents SET commander_id = $2 WHERE id = $1`, [incident.id, target.id]);
  }
  await db.query(
    `INSERT INTO incident_responders (incident_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (incident_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [incident.id, target.id, role]
  );

  const label = RESPONDER_ROLE_LABEL[role];
  const by = self ? "" : ` (by ${actor.name})`;
  let type: TimelineEventType;
  let message: string;
  if (role === "commander") {
    type = "COMMANDER_ASSIGNED";
    message = `${target.name} is now ${label}${by}`;
  } else if (current === null) {
    type = "RESPONDER_ADDED";
    message = self ? `${target.name} joined as ${label}` : `${actor.name} added ${target.name} as ${label}`;
  } else {
    type = "RESPONDER_ROLE_CHANGED";
    message = `${target.name} switched from ${RESPONDER_ROLE_LABEL[current]} to ${label}${by}`;
  }
  await addTimeline(db, fx, incident, type, message, actor, { userId: target.id, from: current, to: role });
  await audit(db, {
    organizationId: incident.organization_id,
    actorUserId: actor.id,
    action: "incident.responder",
    entityType: "incident",
    entityId: incident.id,
    details: { userId: target.id, from: current, to: role },
  });
  fx.publish(incident.organization_id, { type: "incident.updated", incidentId: incident.id, number: incident.number });
  return true;
}

export async function removeResponder(
  db: PoolClient,
  fx: Effects,
  incident: IncidentRow,
  target: Person,
  actor: RoleActor
) {
  assertOpen(incident);
  const self = target.id === actor.id;
  const current = await responderRole(db, incident.id, target.id);
  if (!current) throw new HttpError(404, `${target.name} isn't on this incident`);
  if (!self && !(await canLead(db, incident, actor))) {
    throw new HttpError(403, "Only the incident commander or an admin can remove other people");
  }
  if (current === "commander") throw new HttpError(409, "Hand over command to someone else first");

  await db.query(`DELETE FROM incident_responders WHERE incident_id = $1 AND user_id = $2`, [incident.id, target.id]);
  await addTimeline(
    db,
    fx,
    incident,
    "RESPONDER_REMOVED",
    self ? `${target.name} left the incident` : `${actor.name} removed ${target.name} from the incident`,
    actor,
    { userId: target.id, role: current }
  );
  await audit(db, {
    organizationId: incident.organization_id,
    actorUserId: actor.id,
    action: "incident.responder.remove",
    entityType: "incident",
    entityId: incident.id,
    details: { userId: target.id, role: current },
  });
  fx.publish(incident.organization_id, { type: "incident.updated", incidentId: incident.id, number: incident.number });
}
