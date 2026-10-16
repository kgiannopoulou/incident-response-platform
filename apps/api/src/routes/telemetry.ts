import { Router, type Request } from "express";
import { deploymentPayloadSchema, logBatchSchema } from "@irp/shared";
import type { Deps } from "../deps";
import { recordDeployment, recordLogs } from "../domain/telemetry";
import { requireAuth } from "../lib/auth";
import { HttpError, optionalIdQuery } from "../lib/http";
import { requireApiKey } from "./alerts";

// Evidence for the incident investigator, sent with the service's API key
// (same authentication and rate limit as alerts):
//
//   POST /api/v1/deployments   { version, description?, status?, kind?, startedAt?, … }   (CI/CD)
//   POST /api/v1/logs          { entries: [{ timestamp?, level, message, attributes? }] } (≤ 500)
//   GET  /api/v1/deployments?serviceId=   recent changes (session)

function assertService(req: Request, named: string | undefined) {
  const { service } = req.apiKey!;
  if (named && named.toLowerCase() !== service.slug) {
    throw new HttpError(403, `This API key belongs to service "${service.slug}", not "${named}"`);
  }
  return service;
}

export function deploymentsRouter(deps: Deps) {
  const router = Router();

  router.post("/", requireApiKey(deps), async (req, res) => {
    const payload = deploymentPayloadSchema.parse(req.body);
    const service = assertService(req, payload.service);
    res.status(201).json(await recordDeployment(deps.pool, service, req.apiKey!.keyId, payload));
  });

  router.get("/", requireAuth(deps.jwtSecret), async (req, res) => {
    const serviceId = optionalIdQuery(req.query.serviceId, "serviceId");
    const { rows } = await deps.pool.query(
      `SELECT d.id, d.version, d.commit_sha, d.description, d.author, d.environment, d.status, d.kind, d.url,
              d.started_at, d.finished_at, s.id AS service_id, s.name AS service_name, s.slug AS service_slug
       FROM deployments d JOIN services s ON s.id = d.service_id
       WHERE d.organization_id = $1 AND ($2::int IS NULL OR d.service_id = $2)
       ORDER BY d.started_at DESC LIMIT 100`,
      [req.user!.organizationId, serviceId]
    );
    res.json({ deployments: rows });
  });

  return router;
}

export function logsRouter(deps: Deps) {
  const router = Router();
  router.post("/", requireApiKey(deps), async (req, res) => {
    const batch = logBatchSchema.parse(req.body);
    const service = assertService(req, batch.service);
    res.status(202).json(await recordLogs(deps.pool, service, batch));
  });
  return router;
}
