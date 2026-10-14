import { Router } from "express";
import { buildWebhookPayload, createWebhookSchema, ulid, updateWebhookSchema } from "@irp/shared";
import { generateWebhookSecret } from "@irp/shared/crypto";
import type { Deps } from "../deps";
import { audit } from "../lib/audit";
import { requireAdmin } from "../lib/auth";
import { runTx } from "../lib/effects";
import { HttpError, notFound, parseId } from "../lib/http";

// Outgoing webhook endpoints (admins only):
//
//   GET    /webhooks                      endpoints + recent delivery health
//   POST   /webhooks                      register; returns the signing secret ONCE
//   PATCH  /webhooks/:id                  url, description, events, enabled
//   DELETE /webhooks/:id
//   POST   /webhooks/:id/rotate-secret    new secret, returned once
//   POST   /webhooks/:id/test             queue a signed "ping"
//   GET    /webhooks/:id/deliveries       last 50 attempts with status codes
//   POST   /webhooks/deliveries/:id/redeliver   send a stored payload again
//
// Lifecycle events (incident.triggered / acknowledged / escalated / resolved)
// are fanned out by queueWebhookEvent() in @irp/database, inside the
// transaction that made the change.

const ENDPOINT_COLUMNS = `e.id, e.url, e.description, e.events, e.enabled, e.disabled_reason, e.created_at,
  (SELECT json_build_object('status', d.status, 'responseStatus', d.response_status, 'at', COALESCE(d.delivered_at, d.created_at))
   FROM webhook_deliveries d WHERE d.endpoint_id = e.id ORDER BY d.id DESC LIMIT 1) AS last_delivery,
  (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'failed'
     AND d.created_at > now() - interval '24 hours') AS failures_24h`;

export function webhooksRouter(deps: Deps) {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE e.organization_id = $1 ORDER BY e.id`,
      [req.user!.organizationId]
    );
    res.json({ endpoints: rows });
  });

  router.post("/", async (req, res) => {
    const data = createWebhookSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const secret = generateWebhookSecret();
    const endpoint = await runTx(deps, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO webhook_endpoints (organization_id, url, description, secret, events, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [orgId, data.url, data.description, secret, data.events, req.user!.id]
      );
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "webhook.create",
        entityType: "webhook_endpoint",
        entityId: rows[0].id,
        details: { url: data.url, events: data.events },
      });
      const { rows: created } = await db.query(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE e.id = $1`, [rows[0].id]);
      return created[0];
    });
    // The only response that contains the secret.
    res.status(201).json({ endpoint, secret });
  });

  router.patch("/:id", async (req, res) => {
    const id = parseId(req.params.id, "Webhook");
    const data = updateWebhookSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const endpoint = await runTx(deps, async (db) => {
      const { rows } = await db.query(
        `UPDATE webhook_endpoints SET
           url = COALESCE($3, url),
           description = COALESCE($4, description),
           events = COALESCE($5, events),
           enabled = COALESCE($6, enabled),
           disabled_reason = CASE WHEN $6 IS TRUE THEN NULL ELSE disabled_reason END
         WHERE id = $1 AND organization_id = $2 RETURNING id`,
        [id, orgId, data.url ?? null, data.description ?? null, data.events ?? null, data.enabled ?? null]
      );
      if (!rows[0]) throw notFound("Webhook");
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "webhook.update",
        entityType: "webhook_endpoint",
        entityId: id,
        details: data,
      });
      const { rows: updated } = await db.query(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints e WHERE e.id = $1`, [id]);
      return updated[0];
    });
    res.json({ endpoint });
  });

  router.delete("/:id", async (req, res) => {
    const id = parseId(req.params.id, "Webhook");
    const orgId = req.user!.organizationId;
    await runTx(deps, async (db) => {
      const { rows } = await db.query(`DELETE FROM webhook_endpoints WHERE id = $1 AND organization_id = $2 RETURNING url`, [id, orgId]);
      if (!rows[0]) throw notFound("Webhook");
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "webhook.delete",
        entityType: "webhook_endpoint",
        entityId: id,
        details: { url: rows[0].url },
      });
    });
    res.status(204).end();
  });

  router.post("/:id/rotate-secret", async (req, res) => {
    const id = parseId(req.params.id, "Webhook");
    const orgId = req.user!.organizationId;
    const secret = generateWebhookSecret();
    await runTx(deps, async (db) => {
      const { rowCount } = await db.query(`UPDATE webhook_endpoints SET secret = $3 WHERE id = $1 AND organization_id = $2`, [id, orgId, secret]);
      if (!rowCount) throw notFound("Webhook");
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "webhook.rotate_secret",
        entityType: "webhook_endpoint",
        entityId: id,
      });
    });
    res.json({ secret });
  });

  router.post("/:id/test", async (req, res) => {
    const id = parseId(req.params.id, "Webhook");
    const orgId = req.user!.organizationId;
    const delivery = await runTx(deps, async (db, fx) => {
      const { rows: endpoint } = await db.query(`SELECT id FROM webhook_endpoints WHERE id = $1 AND organization_id = $2`, [id, orgId]);
      if (!endpoint[0]) throw notFound("Webhook");
      const payload = buildWebhookPayload("ping", `evt_${ulid()}`, null, { webOrigin: deps.webOrigin });
      const { rows } = await db.query(
        `INSERT INTO webhook_deliveries (endpoint_id, organization_id, event, payload) VALUES ($1, $2, 'ping', $3)
         RETURNING id, event, status, created_at`,
        [id, orgId, JSON.stringify(payload)]
      );
      fx.deliverWebhooks([rows[0].id]);
      return rows[0];
    });
    res.status(202).json({ delivery });
  });

  router.get("/:id/deliveries", async (req, res) => {
    const id = parseId(req.params.id, "Webhook");
    const { rows: endpoint } = await deps.pool.query(`SELECT 1 FROM webhook_endpoints WHERE id = $1 AND organization_id = $2`, [
      id,
      req.user!.organizationId,
    ]);
    if (!endpoint[0]) throw notFound("Webhook");
    const { rows } = await deps.pool.query(
      `SELECT d.id, d.event, d.status, d.attempts, d.response_status, d.duration_ms, d.last_error, d.created_at,
              d.delivered_at, d.payload, i.number AS incident_number
       FROM webhook_deliveries d LEFT JOIN incidents i ON i.id = d.incident_id
       WHERE d.endpoint_id = $1 ORDER BY d.id DESC LIMIT 50`,
      [id]
    );
    res.json({ deliveries: rows });
  });

  // Sends the stored payload again (same event id, so receivers that dedupe
  // on it treat it as a duplicate). Only for finished deliveries.
  router.post("/deliveries/:id/redeliver", async (req, res) => {
    const id = parseId(req.params.id, "Delivery");
    const orgId = req.user!.organizationId;
    await runTx(deps, async (db, fx) => {
      const { rows } = await db.query(
        `UPDATE webhook_deliveries SET status = 'queued', attempts = 0, last_error = NULL, response_status = NULL
         WHERE id = $1 AND organization_id = $2 AND status <> 'queued' RETURNING id`,
        [id, orgId]
      );
      if (!rows[0]) {
        const { rows: exists } = await db.query(`SELECT 1 FROM webhook_deliveries WHERE id = $1 AND organization_id = $2`, [id, orgId]);
        throw exists[0] ? new HttpError(409, "Delivery is already queued") : notFound("Delivery");
      }
      fx.deliverWebhooks([id]);
    });
    res.status(202).json({ redelivered: true });
  });

  return router;
}
