import type { Pool } from "pg";
import { withTransaction } from "@irp/database";
import { computeDedupKey } from "@irp/shared/dedup";
import { evaluateRules, type AlertPayload, type AlertRule, type RuleCondition } from "@irp/shared";
import { audit } from "../lib/audit";
import { Effects } from "../lib/effects";
import {
  addTimeline,
  attachAlert,
  changeStatus,
  createIncident,
  type IncidentRow,
} from "./incidents";

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
  status: string;
  auto_resolve: boolean;
};

export type IngestResult = {
  alertId: number | null;
  dedupKey: string;
  decision: "incident_created" | "grouped" | "recorded" | "suppressed" | "resolved" | "maintenance";
  reason: string;
  incident: { id: number; number: number; status: string } | null;
};

const summarize = (i: IncidentRow | null) => (i ? { id: i.id, number: i.number, status: i.status } : null);

async function findOpenIncident(db: import("pg").PoolClient, serviceId: number, dedupKey: string) {
  const { rows } = await db.query<IncidentRow>(
    `SELECT * FROM incidents WHERE service_id = $1 AND dedup_key = $2 AND status <> 'resolved' FOR UPDATE`,
    [serviceId, dedupKey]
  );
  return rows[0] ?? null;
}

export async function ingestAlert(
  deps: { pool: Pool; redis: import("ioredis").Redis; queues: import("../deps").Deps["queues"] },
  service: IngestService,
  payload: AlertPayload
): Promise<IngestResult> {
  const dedupKey = payload.dedupKey ?? computeDedupKey(service.id, payload.source, payload.summary);
  const fx = new Effects();

  const result = await withTransaction(deps.pool, async (db): Promise<IngestResult> => {
    if (payload.action === "resolve") {
      return resolveAlerts(db, fx, service, dedupKey);
    }

    const insertAlert = async (status: "firing" | "suppressed", ruleId: number | null) => {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO alerts (organization_id, service_id, dedup_key, summary, severity, source, component,
                             details, status, matched_rule_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          service.organization_id,
          service.id,
          dedupKey,
          payload.summary,
          payload.severity,
          payload.source,
          payload.component ?? null,
          JSON.stringify(payload.details),
          status,
          ruleId,
        ]
      );
      fx.publish(service.organization_id, { type: "alert.received", alertId: rows[0].id, serviceId: service.id });
      return { id: rows[0].id, summary: payload.summary, source: payload.source };
    };

    // Planned maintenance: keep the record, page nobody.
    if (service.status === "maintenance") {
      const alert = await insertAlert("suppressed", null);
      return { alertId: alert.id, dedupKey, decision: "maintenance", reason: "Service is in maintenance", incident: null };
    }

    // Grouping comes first: a repeat of an alert that already has an open
    // incident joins it, whatever the rules would say about a fresh alert.
    const open = await findOpenIncident(db, service.id, dedupKey);
    if (open) {
      const alert = await insertAlert("firing", null);
      await attachAlert(db, fx, open, alert, false);
      return { alertId: alert.id, dedupKey, decision: "grouped", reason: "Grouped into open incident", incident: summarize(open) };
    }

    const { rows: ruleRows } = await db.query<{
      id: number;
      name: string;
      conditions: RuleCondition[];
      action: AlertRule["action"];
      incident_severity: AlertRule["incidentSeverity"];
    }>(`SELECT id, name, conditions, action, incident_severity FROM alert_rules WHERE service_id = $1 ORDER BY position, id`, [
      service.id,
    ]);
    const decision = evaluateRules(
      payload,
      ruleRows.map((r) => ({ id: r.id, name: r.name, conditions: r.conditions, action: r.action, incidentSeverity: r.incident_severity }))
    );

    if (decision.action === "suppress") {
      const alert = await insertAlert("suppressed", decision.ruleId);
      return { alertId: alert.id, dedupKey, decision: "suppressed", reason: decision.reason, incident: null };
    }
    const alert = await insertAlert("firing", decision.ruleId);
    if (decision.action === "record_only") {
      return { alertId: alert.id, dedupKey, decision: "recorded", reason: decision.reason, incident: null };
    }

    const incident = await createIncident(db, fx, {
      organizationId: service.organization_id,
      serviceId: service.id,
      title: payload.summary,
      severity: decision.severity,
      dedupKey,
      actor: null,
      openedBy: `by alert from ${payload.source} (${decision.reason})`,
    });
    if (incident) {
      await attachAlert(db, fx, incident, alert, true);
      return { alertId: alert.id, dedupKey, decision: "incident_created", reason: decision.reason, incident: summarize(incident) };
    }

    // Lost the race: a concurrent request opened the incident for this key
    // between our lookup and insert. Join it instead of failing.
    const winner = await findOpenIncident(db, service.id, dedupKey);
    if (!winner) throw new Error("Dedup conflict without an open incident");
    await attachAlert(db, fx, winner, alert, false);
    return { alertId: alert.id, dedupKey, decision: "grouped", reason: "Grouped into open incident", incident: summarize(winner) };
  });

  await fx.flush(deps);
  return result;
}

// action: "resolve" — the monitoring tool says the problem cleared. Marks
// the matching firing alerts resolved; if the service has auto_resolve and
// an incident has no firing alerts left, the incident is resolved too
// (through the normal state machine, so it gets a postmortem draft and
// resolve notifications like any other).
async function resolveAlerts(
  db: import("pg").PoolClient,
  fx: Effects,
  service: IngestService,
  dedupKey: string
): Promise<IngestResult> {
  const { rows: resolved } = await db.query<{ id: number }>(
    `UPDATE alerts SET status = 'resolved', resolved_at = now()
     WHERE service_id = $1 AND dedup_key = $2 AND status = 'firing' RETURNING id`,
    [service.id, dedupKey]
  );
  const incident = await findOpenIncident(db, service.id, dedupKey);
  let finalIncident = incident;

  if (incident && resolved.length > 0) {
    await addTimeline(db, fx, incident, "alert_resolved", `${resolved.length} alert(s) cleared by the monitoring tool`, null, {
      alertIds: resolved.map((r) => r.id),
    });
    const {
      rows: [{ firing }],
    } = await db.query(
      `SELECT count(*)::int AS firing FROM alerts a JOIN incident_alerts ia ON ia.alert_id = a.id
       WHERE ia.incident_id = $1 AND a.status = 'firing'`,
      [incident.id]
    );
    if (service.auto_resolve && firing === 0) {
      finalIncident = await changeStatus(db, fx, incident, "resolved", null, "all alerts cleared (auto-resolve)");
    }
  }

  await audit(db, {
    organizationId: service.organization_id,
    actorUserId: null,
    action: "alert.resolve",
    entityType: "service",
    entityId: service.id,
    details: { dedupKey, alertsResolved: resolved.length },
  });
  return {
    alertId: null,
    dedupKey,
    decision: "resolved",
    reason: `${resolved.length} firing alert(s) resolved`,
    incident: summarize(finalIncident),
  };
}
