import { Router, type Request } from "express";
import {
  addResponderSchema,
  createIncidentSchema,
  INCIDENT_SEVERITIES,
  INCIDENT_TRANSITIONS,
  noteSchema,
  updatePostmortemSchema,
  updateSeveritySchema,
  updateStatusSchema,
} from "@irp/shared";
import type { Deps } from "../deps";
import {
  addResponder,
  addTimeline,
  changeSeverity,
  changeStatus,
  createIncident,
  generatePostmortem,
  lockIncident,
  type Actor,
} from "../domain/incidents";
import { audit } from "../lib/audit";
import { runTx } from "../lib/effects";
import { HttpError, notFound, parseId } from "../lib/http";

const actorOf = (req: Request): Actor => ({ id: req.user!.id, name: req.user!.name });
const numberParam = (req: Request) => parseId(req.params.number, "Incident");

// Routes are keyed by the per-organization incident number (INC-42 -> 42),
// the identifier people actually say out loud during an incident.
export function incidentsRouter(deps: Deps) {
  const router = Router();

  router.get("/", async (req, res) => {
    const status = (req.query.status as string) ?? "open";
    const severity = INCIDENT_SEVERITIES.includes(req.query.severity as never) ? (req.query.severity as string) : null;
    const serviceId = req.query.serviceId ? Number(req.query.serviceId) : null;
    const { rows } = await deps.pool.query(
      `SELECT i.id, i.number, i.title, i.severity, i.status, i.alert_count, i.escalation_level,
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
        await addTimeline(db, fx, created, "note", data.description, actorOf(req));
      }
      return created!;
    });
    res.status(201).json({ incident });
  });

  router.get("/:number", async (req, res) => {
    const orgId = req.user!.organizationId;
    const { rows } = await deps.pool.query(
      `SELECT i.*, s.name AS service_name, s.status AS service_status, u.name AS commander_name,
              ep.name AS escalation_policy_name
       FROM incidents i
       LEFT JOIN services s ON s.id = i.service_id
       LEFT JOIN escalation_policies ep ON ep.id = s.escalation_policy_id
       LEFT JOIN users u ON u.id = i.commander_id
       WHERE i.organization_id = $1 AND i.number = $2`,
      [orgId, numberParam(req)]
    );
    const incident = rows[0];
    if (!incident) throw notFound("Incident");

    const [alerts, timeline, responders, notifications, postmortem] = await Promise.all([
      deps.pool.query(
        `SELECT a.public_id AS id, a.title, a.description, a.severity, a.source, a.status, a.metadata, a.received_at, a.resolved_at
         FROM alerts a JOIN incident_alerts ia ON ia.alert_id = a.id
         WHERE ia.incident_id = $1 ORDER BY a.received_at`,
        [incident.id]
      ),
      deps.pool.query(
        `SELECT t.id, t.type, t.message, t.metadata, t.created_at, u.name AS actor_name
         FROM timeline_events t LEFT JOIN users u ON u.id = t.actor_user_id
         WHERE t.incident_id = $1 ORDER BY t.created_at, t.id`,
        [incident.id]
      ),
      deps.pool.query(
        `SELECT u.id, u.name, u.email, r.role, r.added_at FROM incident_responders r
         JOIN users u ON u.id = r.user_id WHERE r.incident_id = $1 ORDER BY r.role, r.added_at`,
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
    ]);

    res.json({
      incident: {
        ...incident,
        allowed_transitions: INCIDENT_TRANSITIONS[incident.status as keyof typeof INCIDENT_TRANSITIONS],
      },
      alerts: alerts.rows,
      timeline: timeline.rows,
      responders: responders.rows,
      notifications: notifications.rows,
      postmortem: postmortem.rows[0] ?? null,
    });
  });

  router.post("/:number/status", async (req, res) => {
    const { status, message } = updateStatusSchema.parse(req.body);
    const incident = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      return changeStatus(db, fx, locked, status, actorOf(req), message);
    });
    res.json({ incident });
  });

  // Shorthand used by notification links: "I'm on it".
  router.post("/:number/acknowledge", async (req, res) => {
    const incident = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      return changeStatus(db, fx, locked, "acknowledged", actorOf(req));
    });
    res.json({ incident });
  });

  router.post("/:number/severity", async (req, res) => {
    const { severity } = updateSeveritySchema.parse(req.body);
    const incident = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      return changeSeverity(db, fx, locked, severity, actorOf(req));
    });
    res.json({ incident });
  });

  router.post("/:number/notes", async (req, res) => {
    const { message } = noteSchema.parse(req.body);
    await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      await addTimeline(db, fx, locked, "note", message, actorOf(req));
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

  router.post("/:number/responders", async (req, res) => {
    const { userId, role } = addResponderSchema.parse(req.body);
    await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      // Only members of the same organization can be added.
      const { rows } = await db.query(
        `SELECT u.id, u.name FROM users u JOIN organization_members m ON m.user_id = u.id
         WHERE u.id = $1 AND m.organization_id = $2`,
        [userId, locked.organization_id]
      );
      if (!rows[0]) throw notFound("User");
      await addResponder(db, fx, locked, rows[0], role, actorOf(req));
    });
    res.status(201).json({ ok: true });
  });

  // --- Postmortem --------------------------------------------------------

  router.get("/:number/postmortem", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT p.*, i.number, i.title, i.severity, i.status AS incident_status, s.name AS service_name,
              u.name AS updated_by_name
       FROM postmortems p
       JOIN incidents i ON i.id = p.incident_id
       LEFT JOIN services s ON s.id = i.service_id
       LEFT JOIN users u ON u.id = p.updated_by
       WHERE i.organization_id = $1 AND i.number = $2`,
      [req.user!.organizationId, numberParam(req)]
    );
    if (!rows[0]) throw notFound("Postmortem");
    res.json({ postmortem: rows[0] });
  });

  // Draft it now (or refresh its metrics/timeline). Only for resolved
  // incidents: the metrics aren't final before that.
  router.post("/:number/postmortem", async (req, res) => {
    await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      if (locked.status !== "resolved") {
        throw new HttpError(409, "Resolve the incident before generating its postmortem");
      }
      await generatePostmortem(db, fx, locked, actorOf(req));
      await audit(db, {
        organizationId: locked.organization_id,
        actorUserId: req.user!.id,
        action: "postmortem.generate",
        entityType: "incident",
        entityId: locked.id,
      });
    });
    res.status(201).json({ ok: true });
  });

  router.put("/:number/postmortem", async (req, res) => {
    const data = updatePostmortemSchema.parse(req.body);
    const postmortem = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      const { rows } = await db.query(
        `UPDATE postmortems SET
           summary = COALESCE($2, summary),
           impact = COALESCE($3, impact),
           root_cause = COALESCE($4, root_cause),
           resolution = COALESCE($5, resolution),
           action_items = COALESCE($6, action_items),
           status = COALESCE($7, status),
           updated_at = now(),
           updated_by = $8
         WHERE incident_id = $1 RETURNING *`,
        [
          locked.id,
          data.summary ?? null,
          data.impact ?? null,
          data.rootCause ?? null,
          data.resolution ?? null,
          data.actionItems ? JSON.stringify(data.actionItems) : null,
          data.status ?? null,
          req.user!.id,
        ]
      );
      if (!rows[0]) throw notFound("Postmortem");
      await audit(db, {
        organizationId: locked.organization_id,
        actorUserId: req.user!.id,
        action: data.status === "published" ? "postmortem.publish" : "postmortem.update",
        entityType: "incident",
        entityId: locked.id,
        details: { fields: Object.keys(data) },
      });
      fx.publish(locked.organization_id, { type: "incident.updated", incidentId: locked.id, number: locked.number });
      return rows[0];
    });
    res.json({ postmortem });
  });

  return router;
}
