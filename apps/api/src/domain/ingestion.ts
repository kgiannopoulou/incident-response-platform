import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import { withTransaction } from "@irp/database";
import { computeDedupKey } from "@irp/shared/dedup";
import {
  evaluateRules,
  newAlertId,
  type AlertPayload,
  type AlertRule,
  type AlertSeverity,
  type AlertStatus,
  type RuleCondition,
} from "@irp/shared";
import type { Deps } from "../deps";
import { audit } from "../lib/audit";
import { HttpError } from "../lib/http";
import { Effects } from "../lib/effects";
import { attachAlert, findOpenIncident, groupAlert } from "./correlation";
import { addTimeline, changeStatus, createIncident, type IncidentRow } from "./incidents";

// The alert ingestion pipeline behind POST /api/v1/alerts:
//
//   payload ─► dedup key ─► maintenance? ─► open incident with same key?
//                                              │yes: group alert into it
//                                              │no : matching rules ─► create incident
//                                              │                     ├► record only
//                                              │                     └► suppress
//
// Everything happens in one transaction; realtime events and escalation /
// notification jobs are flushed only after it commits.

export type IngestService = {
  id: number;
  organization_id: number;
  name: string;
  slug: string;
  status: string;
  auto_resolve: boolean;
};

export type IngestResult = {
  id: string | null; // "alert_<ULID>"; null for a resolve
  status: AlertStatus;
  receivedAt: string; // ISO 8601, second precision: "2026-10-10T06:32:18Z"
  service: string;
  deduplicationKey: string;
  decision: "incident_created" | "grouped" | "recorded" | "suppressed" | "resolved" | "maintenance";
  reason: string;
  incident: { id: number; number: number; status: string; severity: string; alertCount: number } | null;
  resolvedCount?: number;
  // True when this is the stored response of an earlier request with the
  // same Idempotency-Key (nothing new was recorded).
  replayed?: boolean;
};

const summarize = (i: IncidentRow | null) =>
  i ? { id: i.id, number: i.number, status: i.status, severity: i.severity, alertCount: i.alert_count } : null;
const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export async function ingestAlert(
  deps: { pool: Pool; redis: Redis; queues: Deps["queues"] },
  service: IngestService,
  apiKeyId: number | null,
  payload: AlertPayload,
  // From the Idempotency-Key header; requestHash = sha256 of the body.
  idempotency?: { key: string; requestHash: string }
): Promise<IngestResult> {
  const dedupKey = payload.deduplicationKey ?? computeDedupKey(service.id, payload.source, payload.title!);
  const fx = new Effects();

  const decide = async (db: PoolClient): Promise<IngestResult> => {
    if (payload.action === "resolve") {
      return resolveAlerts(db, fx, service, dedupKey);
    }
    const title = payload.title!;
    const severity = payload.severity as AlertSeverity;

    const insertAlert = async (status: AlertStatus, ruleId: number | null) => {
      const { rows } = await db.query<{ id: number; public_id: string; received_at: Date }>(
        `INSERT INTO alerts (organization_id, service_id, public_id, api_key_id, dedup_key, title, description,
                             severity, source, metadata, status, matched_rule_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, public_id, received_at`,
        [
          service.organization_id,
          service.id,
          newAlertId(),
          apiKeyId,
          dedupKey,
          title,
          payload.description,
          severity,
          payload.source,
          JSON.stringify(payload.metadata),
          status,
          ruleId,
        ]
      );
      fx.publish(service.organization_id, { type: "alert.received", alertId: rows[0].id, serviceId: service.id });
      return { ...rows[0], title, source: payload.source, severity, status };
    };

    const respond = (
      alert: Awaited<ReturnType<typeof insertAlert>>,
      decision: IngestResult["decision"],
      reason: string,
      incident: IncidentRow | null
    ): IngestResult => ({
      id: alert.public_id,
      status: alert.status,
      receivedAt: isoSeconds(alert.received_at),
      service: service.slug,
      deduplicationKey: dedupKey,
      decision,
      reason,
      incident: summarize(incident),
    });

    // Planned maintenance: keep the record, page nobody.
    if (service.status === "maintenance") {
      const alert = await insertAlert("suppressed", null);
      return respond(alert, "maintenance", "Service is in maintenance", null);
    }

    // Correlation comes first: a repeat of an alert that already has an
    // open incident joins it, whatever the rules would say about a fresh
    // alert (see correlation.ts).
    const open = await findOpenIncident(db, service.id, dedupKey);
    if (open) {
      const alert = await insertAlert("triggered", null);
      const grouped = await groupAlert(db, fx, open, alert);
      return respond(alert, "grouped", `Grouped into open incident (${grouped.alert_count} alerts)`, grouped);
    }

    const { rows: ruleRows } = await db.query<{
      id: number;
      name: string;
      conditions: RuleCondition[];
      action: AlertRule["action"];
      incident_severity: AlertRule["incidentSeverity"];
    }>(
      `SELECT id, name, conditions, action, incident_severity FROM alert_rules
       WHERE service_id = $1 ORDER BY position, id`,
      [service.id]
    );
    const decision = evaluateRules(
      { severity, source: payload.source, title, description: payload.description },
      ruleRows.map((r) => ({
        id: r.id,
        name: r.name,
        conditions: r.conditions,
        action: r.action,
        incidentSeverity: r.incident_severity,
      }))
    );

    if (decision.action === "suppress") {
      const alert = await insertAlert("suppressed", decision.ruleId);
      return respond(alert, "suppressed", decision.reason, null);
    }
    const alert = await insertAlert("triggered", decision.ruleId);
    if (decision.action === "record_only") {
      return respond(alert, "recorded", decision.reason, null);
    }

    const incident = await createIncident(db, fx, {
      organizationId: service.organization_id,
      serviceId: service.id,
      title,
      severity: decision.severity,
      dedupKey,
      actor: null,
      openedBy: `by alert from ${payload.source} (${decision.reason})`,
    });
    if (incident) {
      const withAlert = await attachAlert(db, fx, incident, alert, true);
      return respond(alert, "incident_created", decision.reason, withAlert);
    }

    // Lost the race: a concurrent request opened the incident for this key
    // between our lookup and insert. Join it instead of failing.
    const winner = await findOpenIncident(db, service.id, dedupKey);
    if (!winner) throw new Error("Dedup conflict without an open incident");
    const grouped = await groupAlert(db, fx, winner, alert);
    return respond(alert, "grouped", `Grouped into open incident (${grouped.alert_count} alerts)`, grouped);
  };

  const result = await withTransaction(deps.pool, async (db): Promise<IngestResult> => {
    if (idempotency) {
      const prior = await claimIdempotencyKey(db, service.id, idempotency);
      if (prior) return { ...prior, replayed: true };
    }
    const decided = await decide(db);
    if (idempotency) {
      await db.query(`UPDATE alert_idempotency_keys SET status_code = 202, response = $3 WHERE service_id = $1 AND key = $2`, [
        service.id,
        idempotency.key,
        JSON.stringify(decided),
      ]);
    }
    return decided;
  });

  // A replay changed nothing, so there is nothing to publish or enqueue.
  await fx.flush(deps);
  return result;
}

export const IDEMPOTENCY_TTL_HOURS = 24;

// Idempotency-Key handling, inside the alert's own transaction:
//   new key        -> claim it (INSERT) and process the alert; the response is
//                     stored before COMMIT, so key and alert commit together.
//   key seen before, same body -> return the stored response; nothing recorded.
//   key seen before, other body -> 422: the client reused a key by mistake.
//   same key in flight concurrently -> the INSERT waits for the other
//                     transaction (unique index), then sees its committed row.
//   key older than 24 h -> treated as new.
async function claimIdempotencyKey(
  db: PoolClient,
  serviceId: number,
  { key, requestHash }: { key: string; requestHash: string }
): Promise<IngestResult | null> {
  await db.query(
    `DELETE FROM alert_idempotency_keys
     WHERE service_id = $1 AND key = $2 AND created_at < now() - make_interval(hours => $3)`,
    [serviceId, key, IDEMPOTENCY_TTL_HOURS]
  );
  const claimed = await db.query(
    `INSERT INTO alert_idempotency_keys (service_id, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (service_id, key) DO NOTHING`,
    [serviceId, key, requestHash]
  );
  if (claimed.rowCount) return null;
  const { rows } = await db.query<{ request_hash: string; response: IngestResult | null }>(
    `SELECT request_hash, response FROM alert_idempotency_keys WHERE service_id = $1 AND key = $2`,
    [serviceId, key]
  );
  const prior = rows[0];
  if (!prior?.response) throw new HttpError(409, "A request with this Idempotency-Key is still being processed");
  if (prior.request_hash !== requestHash) {
    throw new HttpError(422, "This Idempotency-Key was already used with a different request body");
  }
  return prior.response;
}

// action: "resolve" — the monitoring tool says the problem cleared. Marks
// the matching triggered alerts resolved; if the service has auto_resolve
// and an incident has no triggered alerts left, the incident is resolved too
// (through the normal state machine, so it gets a postmortem draft and
// resolve notifications like any other).
async function resolveAlerts(
  db: PoolClient,
  fx: Effects,
  service: IngestService,
  dedupKey: string
): Promise<IngestResult> {
  const { rows: resolved } = await db.query<{ id: number }>(
    `UPDATE alerts SET status = 'resolved', resolved_at = now()
     WHERE service_id = $1 AND dedup_key = $2 AND status = 'triggered' RETURNING id`,
    [service.id, dedupKey]
  );
  const incident = await findOpenIncident(db, service.id, dedupKey);
  let finalIncident = incident;

  if (incident && resolved.length > 0) {
    await addTimeline(db, fx, incident, "ALERT_RESOLVED", `${resolved.length} alert(s) cleared by the monitoring tool`, null, {
      alertIds: resolved.map((r) => r.id),
    });
    const {
      rows: [{ active }],
    } = await db.query(
      `SELECT count(*)::int AS active FROM alerts a JOIN incident_alerts ia ON ia.alert_id = a.id
       WHERE ia.incident_id = $1 AND a.status = 'triggered'`,
      [incident.id]
    );
    if (service.auto_resolve && active === 0) {
      finalIncident = await changeStatus(db, fx, incident, "resolved", null, "all alerts cleared (auto-resolve)");
    }
  }

  await audit(db, {
    organizationId: service.organization_id,
    actorUserId: null,
    action: "alert.resolve",
    entityType: "service",
    entityId: service.id,
    details: { deduplicationKey: dedupKey, alertsResolved: resolved.length },
  });
  return {
    id: null,
    status: "resolved",
    receivedAt: isoSeconds(new Date()),
    service: service.slug,
    deduplicationKey: dedupKey,
    decision: "resolved",
    reason: `${resolved.length} triggered alert(s) resolved`,
    incident: summarize(finalIncident),
    resolvedCount: resolved.length,
  };
}
