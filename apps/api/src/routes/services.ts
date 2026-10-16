import { Router } from "express";
import { z } from "zod";
import {
  alertRuleSchema,
  createApiKeySchema,
  createServiceSchema,
  rotateApiKeySchema,
  serviceDependenciesSchema,
  slugify,
  updateServiceSchema,
} from "@irp/shared";
import type { Deps } from "../deps";
import { recomputeServiceStatus } from "../domain/incidents";
import { createApiKey, keyState, listApiKeys, lockApiKey } from "../lib/api-keys";
import { audit } from "../lib/audit";
import { requireAdmin } from "../lib/auth";
import { runTx } from "../lib/effects";
import { HttpError, notFound, parseId } from "../lib/http";

export function servicesRouter(deps: Deps) {
  const router = Router();

  router.get("/", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT s.id, s.name, s.slug, s.description, s.status, s.auto_resolve, s.created_at,
              t.id AS team_id, t.name AS team_name, ep.id AS escalation_policy_id, ep.name AS escalation_policy_name,
              (SELECT count(*)::int FROM incidents i WHERE i.service_id = s.id AND i.status <> 'resolved') AS open_incidents,
              (SELECT max(a.received_at) FROM alerts a WHERE a.service_id = s.id) AS last_alert_at,
              (SELECT count(*)::int FROM api_keys k WHERE k.service_id = s.id AND k.revoked_at IS NULL
                 AND (k.expires_at IS NULL OR k.expires_at > now())) AS active_keys
       FROM services s
       LEFT JOIN teams t ON t.id = s.team_id
       LEFT JOIN escalation_policies ep ON ep.id = s.escalation_policy_id
       WHERE s.organization_id = $1
       ORDER BY s.name`,
      [req.user!.organizationId]
    );
    res.json({ services: rows });
  });

  // Creates the service and its first API key. The key is in this response
  // and nowhere else, ever.
  router.post("/", requireAdmin, async (req, res) => {
    const data = createServiceSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const slug = data.slug ?? slugify(data.name);
    if (!slug) throw new HttpError(400, "Could not derive a slug from that name; pass one explicitly");
    const result = await runTx(deps, async (db, fx) => {
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
          `INSERT INTO services (organization_id, team_id, escalation_policy_id, name, slug, description, auto_resolve)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, slug, description, status, auto_resolve`,
          [orgId, data.teamId ?? null, data.escalationPolicyId ?? null, data.name, slug, data.description, data.autoResolve]
        )
        .catch((err) => {
          if (err.code === "23505") throw new HttpError(409, "A service with that name or slug already exists");
          throw err;
        });
      const { key, plaintext } = await createApiKey(db, {
        organizationId: orgId,
        serviceId: rows[0].id,
        name: "Default",
        rateLimitPerMinute: 120,
        createdBy: req.user!.id,
      });
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "service.create",
        entityType: "service",
        entityId: rows[0].id,
        details: { name: data.name, slug, apiKey: key.prefix },
      });
      fx.publish(orgId, { type: "service.updated", serviceId: rows[0].id });
      return { service: rows[0], apiKey: { ...key, state: keyState(key), key: plaintext } };
    });
    res.status(201).json(result);
  });

  router.patch("/:id", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, "Service");
    const data = updateServiceSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const service = await runTx(deps, async (db, fx) => {
      const { rows } = await db.query(`SELECT * FROM services WHERE id = $1 AND organization_id = $2 FOR NO KEY UPDATE`, [id, orgId]);
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

  // --- API keys ------------------------------------------------------------
  // A service can have several keys: one per sender, or two at once while a
  // rotation is in progress. Plaintext keys appear only in the create/rotate
  // responses; listings show the non-secret prefix.

  const serviceInOrg = async (
    db: Pick<Deps["pool"], "query">,
    serviceId: number,
    orgId: number
  ): Promise<{ id: number; slug: string }> => {
    const { rows } = await db.query(`SELECT id, slug FROM services WHERE id = $1 AND organization_id = $2`, [
      serviceId,
      orgId,
    ]);
    if (!rows[0]) throw notFound("Service");
    return rows[0];
  };

  router.get("/:id/keys", requireAdmin, async (req, res) => {
    const service = await serviceInOrg(deps.pool, parseId(req.params.id, "Service"), req.user!.organizationId);
    res.json({ keys: await listApiKeys(deps.pool, service.id) });
  });

  router.post("/:id/keys", requireAdmin, async (req, res) => {
    const serviceId = parseId(req.params.id, "Service");
    const data = createApiKeySchema.parse(req.body ?? {});
    const created = await runTx(deps, async (db) => {
      await serviceInOrg(db, serviceId, req.user!.organizationId);
      const { key, plaintext } = await createApiKey(db, {
        organizationId: req.user!.organizationId,
        serviceId,
        name: data.name,
        rateLimitPerMinute: data.rateLimitPerMinute,
        createdBy: req.user!.id,
      });
      await audit(db, {
        organizationId: req.user!.organizationId,
        actorUserId: req.user!.id,
        action: "api_key.create",
        entityType: "service",
        entityId: serviceId,
        details: { keyId: key.id, prefix: key.prefix, name: data.name, rateLimitPerMinute: data.rateLimitPerMinute },
      });
      return { ...key, state: keyState(key), key: plaintext };
    });
    res.status(201).json({ apiKey: created });
  });

  // Rotation = issue a replacement and put the old key on a timer. Senders
  // have `graceMinutes` to switch over, during which both keys work; after
  // that the old one is rejected as expired. graceMinutes: 0 cuts it off now.
  router.post("/:id/keys/:keyId/rotate", requireAdmin, async (req, res) => {
    const serviceId = parseId(req.params.id, "Service");
    const keyId = parseId(req.params.keyId, "API key");
    const { graceMinutes } = rotateApiKeySchema.parse(req.body ?? {});
    const result = await runTx(deps, async (db) => {
      await serviceInOrg(db, serviceId, req.user!.organizationId);
      const old = await lockApiKey(db, serviceId, keyId);
      if (!old) throw notFound("API key");
      const state = keyState(old);
      if (state !== "active") {
        throw new HttpError(409, `Only active keys can be rotated (this key is ${state})`);
      }
      const { key, plaintext } = await createApiKey(db, {
        organizationId: req.user!.organizationId,
        serviceId,
        name: old.name,
        rateLimitPerMinute: old.rate_limit_per_minute,
        createdBy: req.user!.id,
      });
      const { rows } = await db.query(
        `UPDATE api_keys SET expires_at = now() + make_interval(mins => $2), replaced_by_id = $3
         WHERE id = $1 RETURNING expires_at`,
        [keyId, graceMinutes, key.id]
      );
      await audit(db, {
        organizationId: req.user!.organizationId,
        actorUserId: req.user!.id,
        action: "api_key.rotate",
        entityType: "service",
        entityId: serviceId,
        details: { oldKeyId: keyId, oldPrefix: old.prefix, newKeyId: key.id, newPrefix: key.prefix, graceMinutes },
      });
      return { apiKey: { ...key, state: keyState(key), key: plaintext }, previousKeyExpiresAt: rows[0].expires_at };
    });
    res.status(201).json(result);
  });

  // Revocation is immediate and final: the next request with this key gets
  // 401. Use it for leaked keys; use rotation for routine changes.
  router.post("/:id/keys/:keyId/revoke", requireAdmin, async (req, res) => {
    const serviceId = parseId(req.params.id, "Service");
    const keyId = parseId(req.params.keyId, "API key");
    const key = await runTx(deps, async (db) => {
      await serviceInOrg(db, serviceId, req.user!.organizationId);
      const existing = await lockApiKey(db, serviceId, keyId);
      if (!existing) throw notFound("API key");
      if (existing.revoked_at) throw new HttpError(409, "This API key is already revoked");
      const { rows } = await db.query(
        `UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1
         RETURNING id, name, prefix, revoked_at`,
        [keyId, req.user!.id]
      );
      await audit(db, {
        organizationId: req.user!.organizationId,
        actorUserId: req.user!.id,
        action: "api_key.revoke",
        entityType: "service",
        entityId: serviceId,
        details: { keyId, prefix: existing.prefix },
      });
      return { ...rows[0], state: "revoked" as const };
    });
    res.json({ apiKey: key });
  });

  router.get("/:id/rules", async (req, res) => {
    const id = parseId(req.params.id, "Service");
    // 404 for another organization's service (like every other route),
    // rather than an empty list.
    const { rows: service } = await deps.pool.query(`SELECT 1 FROM services WHERE id = $1 AND organization_id = $2`, [
      id,
      req.user!.organizationId,
    ]);
    if (!service[0]) throw notFound("Service");
    const { rows } = await deps.pool.query(
      `SELECT id, position, name, conditions, action, incident_severity
       FROM alert_rules WHERE service_id = $1 ORDER BY position, id`,
      [id]
    );
    res.json({ rules: rows });
  });

  // Replaces the whole ordered rule list (the editor saves it as one unit).
  router.put("/:id/rules", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, "Service");
    const { rules } = z.object({ rules: z.array(alertRuleSchema).max(50) }).parse(req.body);
    await runTx(deps, async (db) => {
      const { rows } = await db.query(`SELECT 1 FROM services WHERE id = $1 AND organization_id = $2 FOR NO KEY UPDATE`, [
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

  // What a service depends on (and what depends on it). The incident
  // investigator looks upstream along these edges.
  router.get("/:id/dependencies", async (req, res) => {
    const id = parseId(req.params.id, "Service");
    const { rows: service } = await deps.pool.query(`SELECT 1 FROM services WHERE id = $1 AND organization_id = $2`, [
      id,
      req.user!.organizationId,
    ]);
    if (!service[0]) throw notFound("Service");
    const { rows } = await deps.pool.query(
      `SELECT 'dependsOn' AS direction, s.id, s.name, s.slug, s.status FROM service_dependencies d JOIN services s ON s.id = d.depends_on_service_id
       WHERE d.service_id = $1
       UNION ALL
       SELECT 'dependents', s.id, s.name, s.slug, s.status FROM service_dependencies d JOIN services s ON s.id = d.service_id
       WHERE d.depends_on_service_id = $1
       ORDER BY 1, 3`,
      [id]
    );
    const pick = (direction: string) => rows.filter((r) => r.direction === direction).map(({ direction: _d, ...s }) => s);
    res.json({ dependsOn: pick("dependsOn"), dependents: pick("dependents") });
  });

  // Replaces the list of services this one depends on.
  router.put("/:id/dependencies", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, "Service");
    const { dependsOn } = serviceDependenciesSchema.parse(req.body);
    const unique = [...new Set(dependsOn)];
    if (unique.includes(id)) throw new HttpError(400, "A service can't depend on itself");
    await runTx(deps, async (db) => {
      const orgId = req.user!.organizationId;
      const { rows } = await db.query(`SELECT 1 FROM services WHERE id = $1 AND organization_id = $2 FOR NO KEY UPDATE`, [id, orgId]);
      if (!rows[0]) throw notFound("Service");
      // Same-organization targets only (a foreign id looks like a missing one).
      const { rows: found } = await db.query<{ id: number }>(`SELECT id FROM services WHERE id = ANY($1) AND organization_id = $2`, [unique, orgId]);
      if (found.length !== unique.length) throw notFound("Service");
      await db.query(`DELETE FROM service_dependencies WHERE service_id = $1`, [id]);
      if (unique.length) {
        await db.query(`INSERT INTO service_dependencies (service_id, depends_on_service_id) SELECT $1, unnest($2::int[])`, [id, unique]);
      }
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "service.dependencies",
        entityType: "service",
        entityId: id,
        details: { dependsOn: unique },
      });
    });
    res.json({ ok: true });
  });

  return router;
}
