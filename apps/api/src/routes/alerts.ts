import { Router, type NextFunction, type Request, type Response } from "express";
import { alertPayloadSchema } from "@irp/shared";
import { hashIntegrationKey } from "@irp/shared/dedup";
import type { Deps } from "../deps";
import { ingestAlert, type IngestService } from "../domain/ingestion";
import { requireAuth } from "../lib/auth";
import { HttpError } from "../lib/http";

declare module "express-serve-static-core" {
  interface Request {
    integrationService?: IngestService;
  }
}

// Monitoring tools authenticate with a per-service integration key, not a
// user session. The key identifies both the organization and the service.
function requireIntegrationKey(deps: Deps) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice(7).trim() : (req.headers["x-integration-key"] as string);
    if (!key) return next(new HttpError(401, "Missing integration key"));
    const { rows } = await deps.pool.query<IngestService>(
      `SELECT id, organization_id, name, status, auto_resolve FROM services WHERE integration_key_hash = $1`,
      [hashIntegrationKey(key)]
    );
    if (!rows[0]) return next(new HttpError(401, "Unknown integration key"));
    req.integrationService = rows[0];
    next();
  };
}

export function alertsRouter(deps: Deps) {
  const router = Router();

  // Ingestion endpoint. 202 Accepted: the alert is stored and the incident
  // decided synchronously, but paging happens asynchronously in the worker.
  router.post("/", requireIntegrationKey(deps), async (req, res) => {
    const payload = alertPayloadSchema.parse(req.body);
    const result = await ingestAlert(deps, req.integrationService!, payload);
    res.status(202).json(result);
  });

  // Recent alerts for the dashboard's alert feed.
  router.get("/", requireAuth(deps.jwtSecret), async (req, res) => {
    const serviceId = req.query.serviceId ? Number(req.query.serviceId) : null;
    const { rows } = await deps.pool.query(
      `SELECT a.id, a.summary, a.severity, a.source, a.component, a.status, a.dedup_key, a.received_at,
              a.resolved_at, s.id AS service_id, s.name AS service_name, r.name AS matched_rule,
              i.number AS incident_number
       FROM alerts a
       JOIN services s ON s.id = a.service_id
       LEFT JOIN alert_rules r ON r.id = a.matched_rule_id
       LEFT JOIN incident_alerts ia ON ia.alert_id = a.id
       LEFT JOIN incidents i ON i.id = ia.incident_id
       WHERE a.organization_id = $1 AND ($2::int IS NULL OR a.service_id = $2)
       ORDER BY a.received_at DESC, a.id DESC LIMIT 100`,
      [req.user!.organizationId, serviceId]
    );
    res.json({ alerts: rows });
  });

  return router;
}
