import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { alertPayloadSchema, ALERT_SEVERITIES, ALERT_STATUSES } from "@irp/shared";
import type { Deps } from "../deps";
import { ingestAlert } from "../domain/ingestion";
import { authenticateApiKey, type AuthenticatedKey } from "../lib/api-keys";
import { requireAuth } from "../lib/auth";
import { HttpError, optionalIdQuery } from "../lib/http";

declare module "express-serve-static-core" {
  interface Request {
    apiKey?: AuthenticatedKey;
  }
}

const AUTH_MESSAGES = {
  missing: "Missing API key: send Authorization: Bearer <key>",
  unknown: "Invalid API key",
  revoked: "API key has been revoked",
  expired: "API key has expired (it was rotated); use the new key",
};

// Machine authentication for alert ingestion:
//   blocked IP? -> 429 | missing/invalid/revoked/expired key -> 401
//   over the key's rate limit -> 429 | otherwise continue.
export function requireApiKey(deps: Deps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? "unknown";
    if (await deps.rateLimiter.isBlocked(ip)) {
      res.setHeader("Retry-After", "60");
      return next(new HttpError(429, "Too many failed authentication attempts; try again in a minute"));
    }

    const header = req.headers.authorization;
    const rawKey = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const fail = async (message: string) => {
      await deps.rateLimiter.recordAuthFailure(ip);
      next(new HttpError(401, message));
    };
    if (!rawKey) return fail(AUTH_MESSAGES.missing);

    const lookup = await authenticateApiKey(deps.pool, rawKey);
    if (!lookup.ok) return fail(AUTH_MESSAGES[lookup.reason]);

    const limit = await deps.rateLimiter.consumeKey(lookup.key.keyId, lookup.key.rateLimitPerMinute);
    res.setHeader("RateLimit-Limit", String(limit.limit));
    res.setHeader("RateLimit-Remaining", String(limit.remaining));
    res.setHeader("RateLimit-Reset", String(limit.resetSeconds));
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      return next(new HttpError(429, `Rate limit of ${limit.limit} alerts per minute exceeded for this API key`));
    }

    req.apiKey = lookup.key;
    next();
  };
}

// `Idempotency-Key: <any unique string>` makes a retried POST safe: the
// first request's response is stored and replayed for repeats (see
// claimIdempotencyKey). The SDK sends one per alert() call automatically.
function idempotencyFrom(req: Request) {
  const key = req.get("Idempotency-Key")?.trim();
  if (!key) return undefined;
  if (key.length > 255 || !/^[!-~]+$/.test(key)) {
    throw new HttpError(400, "Idempotency-Key must be 1-255 printable ASCII characters without spaces");
  }
  return { key, requestHash: createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex") };
}

// Times every ingestion request, rejected ones included, from arrival to the
// response being handed to the socket (System page, load test).
function timeIngestion(deps: Deps) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const stats = deps.ingestionStats;
    if (!stats) return next();
    const started = performance.now();
    res.on("finish", () => stats.record(performance.now() - started, res.statusCode, res.locals.decision ?? null));
    next();
  };
}

export function alertsRouter(deps: Deps) {
  const router = Router();

  // Ingestion endpoint. 202 Accepted: the alert is stored and its incident
  // decided synchronously, but paging happens asynchronously in the worker.
  router.post("/", timeIngestion(deps), requireApiKey(deps), async (req, res) => {
    const payload = alertPayloadSchema.parse(req.body);
    const { service } = req.apiKey!;
    // The key decides the service. A body naming a different one is
    // rejected rather than silently re-routed.
    if (payload.service && payload.service.toLowerCase() !== service.slug) {
      throw new HttpError(403, `This API key belongs to service "${service.slug}", not "${payload.service}"`);
    }
    const result = await ingestAlert(deps, service, req.apiKey!.keyId, payload, idempotencyFrom(req));
    res.locals.decision = result.decision;
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(202).json(result);
  });

  // Alert feed for the dashboard (session auth), newest first.
  router.get("/", requireAuth(deps.jwtSecret), async (req, res) => {
    const serviceId = optionalIdQuery(req.query.serviceId, "serviceId");
    const severity = ALERT_SEVERITIES.includes(req.query.severity as never) ? (req.query.severity as string) : null;
    const status = ALERT_STATUSES.includes(req.query.status as never) ? (req.query.status as string) : null;
    const { rows } = await deps.pool.query(
      `SELECT a.public_id AS id, a.title, a.description, a.severity, a.source, a.status, a.dedup_key,
              a.metadata, a.received_at, a.resolved_at,
              s.id AS service_id, s.name AS service_name, s.slug AS service_slug,
              r.name AS matched_rule, k.prefix AS api_key_prefix, i.number AS incident_number
       FROM alerts a
       JOIN services s ON s.id = a.service_id
       LEFT JOIN alert_rules r ON r.id = a.matched_rule_id
       LEFT JOIN api_keys k ON k.id = a.api_key_id
       LEFT JOIN incident_alerts ia ON ia.alert_id = a.id
       LEFT JOIN incidents i ON i.id = ia.incident_id
       WHERE a.organization_id = $1
         AND ($2::int IS NULL OR a.service_id = $2)
         AND ($3::text IS NULL OR a.severity = $3)
         AND ($4::text IS NULL OR a.status = $4)
       ORDER BY a.received_at DESC, a.id DESC LIMIT 200`,
      [req.user!.organizationId, serviceId, severity, status]
    );
    res.json({ alerts: rows });
  });

  return router;
}
