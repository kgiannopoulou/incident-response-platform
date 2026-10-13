import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { alertRuleSchema, createServiceSchema, updateServiceSchema } from "@irp/shared";
import { hashIntegrationKey } from "@irp/shared/dedup";
import type { Deps } from "../deps";
import { recomputeServiceStatus } from "../domain/incidents";
import { audit } from "../lib/audit";
import { requireAdmin } from "../lib/auth";
import { runTx } from "../lib/effects";
import { HttpError, notFound, parseId } from "../lib/http";

// Integration keys are shown exactly once (on create / rotate); only the
// hash is stored, like a password.
const newIntegrationKey = () => `irp_${randomBytes(24).toString("base64url")}`;

export function servicesRouter(deps: Deps) {
  const router = Router();

  router.get("/", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT s.id, s.name, s.description, s.status, s.auto_resolve, s.created_at,
              t.id AS team_id, t.name AS team_name, ep.id AS escalation_policy_id, ep.name AS escalation_policy_name,
              (SELECT count(*)::int FROM incidents i WHERE i.service_id = s.id AND i.status <> 'resolved') AS open_incidents,
              (SELECT max(a.received_at) FROM alerts a WHERE a.service_id = s.id) AS last_alert_at
       FROM services s
       LEFT JOIN teams t ON t.id = s.team_id
       LEFT JOIN escalation_policies ep ON ep.id = s.escalation_policy_id
       WHERE s.organization_id = $1
       ORDER BY s.name`,
      [req.user!.organizationId]
    );
    res.json({ services: rows });
  });

  router.post("/", requireAdmin, async (req, res) => {
    const data = createServiceSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const key = newIntegrationKey();
    const service = await runTx(deps, async (db, fx) => {
      // Team / policy must belong to the same organization.
      if (data.teamId) {
        const { rows } = await db.query(`SELECT 1 FROM teams WHERE id = $1 AND organization_id = $2`, [data.teamId, orgId]);
        if (!rows[0]) throw notFound("Team");
      }
      if (data.escalationPolicyId) {
        const { rows } = await db.query(`SELECT 1 FROM escalation_policies WHERE id = $1 AND organization_id = $2`, [
          data.escalationPolicyId,
          orgId,
        ]);
        if (!rows[0]) throw notFound("Escalation policy");
      }
      const { rows } = await db
        .query(
          `INSERT INTO services (organization_id, team_id, escalation_policy_id, name, description,
                                 integration_key_hash, auto_resolve)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, description, status, auto_resolve`,
          [orgId, data.teamId ?? null, data.escalationPolicyId ?? null, data.name, data.description, hashIntegrationKey(key), data.autoResolve]
        )
        .catch((err) => {
          if (err.code === "23505") throw new HttpError(409, "A service with that name already exists");
          throw err;
        });
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "service.create",
        entityType: "service",
        entityId: rows[0].id,
        details: { name: data.name },
      });
      fx.publish(orgId, { type: "service.updated", serviceId: rows[0].id });
      return rows[0];
    });
    res.status(201).json({ service, integrationKey: key });
  });

  router.patch("/:id", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, "Service");
    const data = updateServiceSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const service = await runTx(deps, async (db, fx) => {
      const { rows } = await db.query(`SELECT * FROM services WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [id, orgId]);
      if (!rows[0]) throw notFound("Service");
      await db.query(
        `UPDATE services SET
           description = COALESCE($2, description),
           auto_resolve = COALESCE($3, auto_resolve),
           escalation_policy_id = CASE WHEN $4 THEN $5 ELSE escalation_policy_id END,
           status = CASE WHEN $6::boolean IS TRUE THEN 'maintenance'
                         WHEN $6::boolean IS FALSE AND status = 'maintenance' THEN 'operational'
                         ELSE status END
         WHERE id = $1`,
        [
          id,
          data.description ?? null,
          data.autoResolve ?? null,
          data.escalationPolicyId !== undefined,
          data.escalationPolicyId ?? null,
          data.maintenance ?? null,
        ]
      );
      // Leaving maintenance: status goes back to whatever open incidents imply.
      if (data.maintenance === false) await recomputeServiceStatus(db, fx, id);
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "service.update",
        entityType: "service",
        entityId: id,
        details: data,
      });
      fx.publish(orgId, { type: "service.updated", serviceId: id });
      const { rows: updated } = await db.query(`SELECT id, name, description, status, auto_resolve, escalation_policy_id FROM services WHERE id = $1`, [id]);
      return updated[0];
    });
    res.json({ service });
  });

  router.post("/:id/rotate-key", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, "Service");
    const key = newIntegrationKey();
    await runTx(deps, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE services SET integration_key_hash = $3 WHERE id = $1 AND organization_id = $2`,
        [id, req.user!.organizationId, hashIntegrationKey(key)]
      );
      if (!rowCount) throw notFound("Service");
      await audit(db, {
        organizationId: req.user!.organizationId,
        actorUserId: req.user!.id,
        action: "service.rotate_key",
        entityType: "service",
        entityId: id,
      });
    });
    res.json({ integrationKey: key });
  });

  router.get("/:id/rules", async (req, res) => {
    const id = parseId(req.params.id, "Service");
    const { rows } = await deps.pool.query(
      `SELECT r.id, r.position, r.name, r.conditions, r.action, r.incident_severity
       FROM alert_rules r JOIN services s ON s.id = r.service_id
       WHERE r.service_id = $1 AND s.organization_id = $2 ORDER BY r.position, r.id`,
      [id, req.user!.organizationId]
    );
    res.json({ rules: rows });
  });

  // Replaces the whole ordered rule list (the editor saves it as one unit).
  router.put("/:id/rules", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, "Service");
    const { rules } = z.object({ rules: z.array(alertRuleSchema).max(50) }).parse(req.body);
    await runTx(deps, async (db) => {
      const { rows } = await db.query(`SELECT 1 FROM services WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [
        id,
        req.user!.organizationId,
      ]);
      if (!rows[0]) throw notFound("Service");
      await db.query(`DELETE FROM alert_rules WHERE service_id = $1`, [id]);
      for (const [position, rule] of rules.entries()) {
        await db.query(
          `INSERT INTO alert_rules (service_id, position, name, conditions, action, incident_severity)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, position, rule.name, JSON.stringify(rule.conditions), rule.action, rule.incidentSeverity ?? null]
        );
      }
      await audit(db, {
        organizationId: req.user!.organizationId,
        actorUserId: req.user!.id,
        action: "service.rules",
        entityType: "service",
        entityId: id,
        details: { count: rules.length },
      });
    });
    res.json({ ok: true });
  });

  return router;
}
