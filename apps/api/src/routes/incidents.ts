import { Router, type Request } from "express";
import {
  addResponderSchema,
  updateResponderSchema,
  createIncidentSchema,
  INCIDENT_SEVERITIES,
  INCIDENT_TRANSITIONS,
  noteSchema,
  updateSeveritySchema,
  updateStatusSchema,
} from "@irp/shared";
import type { Deps } from "../deps";
import {
  addTimeline,
  changeSeverity,
  changeStatus,
  createIncident,
  escalateNow,
  lockIncident,
  type Actor,
} from "../domain/incidents";
import { assertCanAct, removeResponder, setResponderRole, type RoleActor } from "../domain/responders";
import type { PoolClient } from "@irp/database";
import { audit } from "../lib/audit";
import { runTx } from "../lib/effects";
import { notFound, optionalIdQuery, parseId } from "../lib/http";

const actorOf = (req: Request): Actor => ({ id: req.user!.id, name: req.user!.name });
const numberParam = (req: Request) => parseId(req.params.number, "Incident");
const roleActorOf = (req: Request): RoleActor => ({ id: req.user!.id, name: req.user!.name, isAdmin: req.user!.role === "admin" });

// Only members of the incident's organization can be put on it.
async function orgMember(db: PoolClient, organizationId: number, userId: number) {
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT u.id, u.name FROM users u JOIN organization_members m ON m.user_id = u.id
     WHERE u.id = $1 AND m.organization_id = $2`,
    [userId, organizationId]
  );
  if (!rows[0]) throw notFound("User");
  return rows[0];
}

// Routes are keyed by the per-organization incident number (INC-42 -> 42),
// the identifier people actually say out loud during an incident.
export function incidentsRouter(deps: Deps) {
  const router = Router();

  router.get("/", async (req, res) => {
    const status = (req.query.status as string) ?? "open";
    const severity = INCIDENT_SEVERITIES.includes(req.query.severity as never) ? (req.query.severity as string) : null;
    const serviceId = optionalIdQuery(req.query.serviceId, "serviceId");
    const { rows } = await deps.pool.query(
      `SELECT i.id, i.number, i.title, i.severity, i.status, i.alert_count, i.last_alert_at, i.escalation_level,
              i.triggered_at, i.acknowledged_at, i.resolved_at,
              s.id AS service_id, s.name AS service_name, u.name AS commander_name
       FROM incidents i
       LEFT JOIN services s ON s.id = i.service_id
       LEFT JOIN users u ON u.id = i.commander_id
       WHERE i.organization_id = $1
         AND ($2 = 'all' OR ($2 = 'open' AND i.status <> 'resolved') OR i.status = $2)
         AND ($3::text IS NULL OR i.severity = $3)
         AND ($4::int IS NULL OR i.service_id = $4)
       ORDER BY (i.status = 'resolved'), i.severity, i.triggered_at DESC
       LIMIT 200`,
      [req.user!.organizationId, status, severity, serviceId]
    );
    res.json({ incidents: rows });
  });

  // Manually declared incident ("Our checkout service is down").
  router.post("/", async (req, res) => {
    const data = createIncidentSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const incident = await runTx(deps, async (db, fx) => {
      if (data.serviceId) {
        const { rows } = await db.query(`SELECT 1 FROM services WHERE id = $1 AND organization_id = $2`, [
          data.serviceId,
          orgId,
        ]);
        if (!rows[0]) throw notFound("Service");
      }
      const created = await createIncident(db, fx, {
        organizationId: orgId,
        serviceId: data.serviceId ?? null,
        title: data.title,
        severity: data.severity,
        dedupKey: null,
        actor: actorOf(req),
        openedBy: `manually by ${req.user!.name}`,
      });
      if (created && data.description) {
        await addTimeline(db, fx, created, "NOTE_ADDED", data.description, actorOf(req));
      }
      return created!;
    });
    res.status(201).json({ incident });
  });

  router.get("/:number", async (req, res) => {
    const orgId = req.user!.organizationId;
    const { rows } = await deps.pool.query(
      `SELECT i.*, s.name AS service_name, s.status AS service_status, u.name AS commander_name,
              ep.name AS escalation_policy_name,
              (SELECT max(position) FROM escalation_steps st WHERE st.policy_id = ep.id) AS escalation_max_level
       FROM incidents i
       LEFT JOIN services s ON s.id = i.service_id
       LEFT JOIN escalation_policies ep ON ep.id = s.escalation_policy_id
       LEFT JOIN users u ON u.id = i.commander_id
       WHERE i.organization_id = $1 AND i.number = $2`,
      [orgId, numberParam(req)]
    );
    const incident = rows[0];
    if (!incident) throw notFound("Incident");

    const [alerts, timeline, responders, notifications, postmortem, integrity] = await Promise.all([
      deps.pool.query(
        `SELECT a.public_id AS id, a.title, a.description, a.severity, a.source, a.status, a.metadata, a.received_at, a.resolved_at
         FROM alerts a JOIN incident_alerts ia ON ia.alert_id = a.id
         WHERE ia.incident_id = $1 ORDER BY a.received_at`,
        [incident.id]
      ),
      deps.pool.query(
        `SELECT t.id, t.event_type, t.actor_id, t.message, t.metadata, t.created_at, u.name AS actor_name
         FROM timeline_events t LEFT JOIN users u ON u.id = t.actor_id
         WHERE t.incident_id = $1 ORDER BY t.id`,
        [incident.id]
      ),
      deps.pool.query(
        `SELECT u.id, u.name, u.email, r.role, r.joined_at FROM incident_responders r
         JOIN users u ON u.id = r.user_id WHERE r.incident_id = $1
         ORDER BY array_position(ARRAY['commander', 'responder', 'observer'], r.role), r.joined_at`,
        [incident.id]
      ),
      deps.pool.query(
        `SELECT n.id, n.kind, n.channel, n.status, n.escalation_level, n.attempts, n.created_at, n.sent_at,
                u.name AS user_name
         FROM notifications n JOIN users u ON u.id = n.user_id
         WHERE n.incident_id = $1 ORDER BY n.created_at, n.id`,
        [incident.id]
      ),
      deps.pool.query(`SELECT status, updated_at FROM postmortems WHERE incident_id = $1`, [incident.id]),
      deps.pool.query(`SELECT valid, events, first_invalid_id FROM timeline_verify($1)`, [incident.id]),
    ]);

    res.json({
      incident: {
        ...incident,
        allowed_transitions: INCIDENT_TRANSITIONS[incident.status as keyof typeof INCIDENT_TRANSITIONS],
      },
      alerts: alerts.rows,
      timeline: timeline.rows,
      timeline_integrity: integrity.rows[0],
      responders: responders.rows,
      notifications: notifications.rows,
      postmortem: postmortem.rows[0] ?? null,
    });
  });

  // The append-only timeline on its own, plus the result of re-verifying its
  // hash chain. There is intentionally no PUT/PATCH/DELETE for events.
  router.get("/:number/timeline", async (req, res) => {
    const { rows: found } = await deps.pool.query<{ id: number }>(
      `SELECT id FROM incidents WHERE organization_id = $1 AND number = $2`,
      [req.user!.organizationId, numberParam(req)]
    );
    if (!found[0]) throw notFound("Incident");
    const [events, integrity] = await Promise.all([
      deps.pool.query(
        `SELECT t.id, t.event_type, t.actor_id, u.name AS actor_name, t.message, t.metadata, t.created_at,
                t.prev_hash, t.hash
         FROM timeline_events t LEFT JOIN users u ON u.id = t.actor_id
         WHERE t.incident_id = $1 ORDER BY t.id`,
        [found[0].id]
      ),
      deps.pool.query(`SELECT valid, events, first_invalid_id FROM timeline_verify($1)`, [found[0].id]),
    ]);
    res.json({ events: events.rows, integrity: integrity.rows[0] });
  });

  router.post("/:number/status", async (req, res) => {
    const { status, message } = updateStatusSchema.parse(req.body);
    const incident = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      await assertCanAct(db, locked, req.user!);
      return changeStatus(db, fx, locked, status, actorOf(req), message);
    });
    res.json({ incident });
  });

  // Shorthand used by notification links: "I'm on it".
  router.post("/:number/acknowledge", async (req, res) => {
    const incident = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      await assertCanAct(db, locked, req.user!);
      return changeStatus(db, fx, locked, "acknowledged", actorOf(req));
    });
    res.json({ incident });
  });

  // Page the next escalation level now ("Escalate" on the incident page).
  router.post("/:number/escalate", async (req, res) => {
    const incident = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      await assertCanAct(db, locked, req.user!);
      return escalateNow(db, fx, locked, actorOf(req));
    });
    res.json({ incident });
  });

  router.post("/:number/severity", async (req, res) => {
    const { severity } = updateSeveritySchema.parse(req.body);
    const incident = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      await assertCanAct(db, locked, req.user!);
      return changeSeverity(db, fx, locked, severity, actorOf(req));
    });
    res.json({ incident });
  });

  router.post("/:number/notes", async (req, res) => {
    const { message } = noteSchema.parse(req.body);
    await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      await assertCanAct(db, locked, req.user!);
      await addTimeline(db, fx, locked, "NOTE_ADDED", message, actorOf(req));
      await audit(db, {
        organizationId: locked.organization_id,
        actorUserId: req.user!.id,
        action: "incident.note",
        entityType: "incident",
        entityId: locked.id,
      });
    });
    res.status(201).json({ ok: true });
  });

  // --- Responders ---------------------------------------------------------

  // Join (no userId) or add someone, as commander / responder / observer.
  router.post("/:number/responders", async (req, res) => {
    const { userId, role } = addResponderSchema.parse(req.body);
    const changed = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      const target = await orgMember(db, locked.organization_id, userId ?? req.user!.id);
      return setResponderRole(db, fx, locked, target, role, roleActorOf(req));
    });
    res.status(changed ? 201 : 200).json({ ok: true, changed });
  });

  // Change a role: switch to observer, hand over command, …
  router.patch("/:number/responders/:userId", async (req, res) => {
    const { role } = updateResponderSchema.parse(req.body);
    const changed = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      const target = await orgMember(db, locked.organization_id, parseId(req.params.userId, "User"));
      return setResponderRole(db, fx, locked, target, role, roleActorOf(req));
    });
    res.json({ ok: true, changed });
  });

  // Leave (yourself) or remove someone.
  router.delete("/:number/responders/:userId", async (req, res) => {
    await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      const target = await orgMember(db, locked.organization_id, parseId(req.params.userId, "User"));
      await removeResponder(db, fx, locked, target, roleActorOf(req));
    });
    res.status(204).end();
  });

  return router;
}
