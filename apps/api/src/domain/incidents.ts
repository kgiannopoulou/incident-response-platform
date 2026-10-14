import type { PoolClient } from "@irp/database";
import {
  type AlertSeverity,
  assertTransition,
  buildPostmortemDraft,
  deriveServiceStatus,
  incidentRef,
  type IncidentSeverity,
  type IncidentStatus,
  type ServiceStatus,
  type TimelineEventType,
} from "@irp/shared";
import { audit } from "../lib/audit";
import type { Effects } from "../lib/effects";
import { HttpError } from "../lib/http";

// Incident operations shared by the HTTP routes and alert ingestion. Every
// function runs inside the caller's transaction (`db`) and records realtime
// events / jobs on `fx`, which the caller flushes after COMMIT.

export type Actor = { id: number; name: string } | null; // null = system / integration

export type IncidentRow = {
  id: number;
  organization_id: number;
  number: number;
  service_id: number | null;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  dedup_key: string | null;
  commander_id: number | null;
  escalation_level: number;
  next_escalation_at: Date | null;
  alert_count: number;
  last_alert_at: Date | null;
  highest_alert_severity: AlertSeverity | null;
  triggered_at: Date;
  acknowledged_at: Date | null;
  mitigated_at: Date | null;
  resolved_at: Date | null;
};

const changed = (fx: Effects, incident: IncidentRow) =>
  fx.publish(incident.organization_id, {
    type: "incident.updated",
    incidentId: incident.id,
    number: incident.number,
  });

export async function addTimeline(
  db: PoolClient,
  fx: Effects,
  incident: Pick<IncidentRow, "id" | "organization_id">,
  type: TimelineEventType,
  message: string,
  actor: Actor,
  metadata: Record<string, unknown> = {}
) {
  await db.query(
    `INSERT INTO timeline_events (incident_id, type, actor_user_id, message, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [incident.id, type, actor?.id ?? null, message, JSON.stringify(metadata)]
  );
  fx.publish(incident.organization_id, { type: "timeline.added", incidentId: incident.id });
}

// Row-locks the incident for the rest of the transaction, so two responders
// clicking "Acknowledge" at the same moment are serialized and the second
// one gets a clean state-machine error instead of a double transition.
export async function lockIncident(db: PoolClient, organizationId: number, number: number) {
  const { rows } = await db.query<IncidentRow>(
    `SELECT * FROM incidents WHERE organization_id = $1 AND number = $2 FOR UPDATE`,
    [organizationId, number]
  );
  if (!rows[0]) throw new HttpError(404, `${incidentRef(number)} not found`);
  return rows[0];
}

async function addResponderRow(db: PoolClient, incidentId: number, userId: number, role: "commander" | "responder") {
  // Joining twice is a no-op; joining as commander upgrades the role.
  await db.query(
    `INSERT INTO incident_responders (incident_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (incident_id, user_id) DO UPDATE
       SET role = CASE WHEN EXCLUDED.role = 'commander' THEN 'commander' ELSE incident_responders.role END`,
    [incidentId, userId, role]
  );
}

// Service status follows its worst open incident (outage / degraded /
// operational); maintenance is a manual override.
export async function recomputeServiceStatus(db: PoolClient, fx: Effects, serviceId: number | null) {
  if (!serviceId) return;
  const { rows } = await db.query<{ status: ServiceStatus; organization_id: number }>(
    `SELECT status, organization_id FROM services WHERE id = $1 FOR UPDATE`,
    [serviceId]
  );
  if (!rows[0]) return;
  const { rows: open } = await db.query<{ severity: IncidentSeverity; status: IncidentStatus }>(
    `SELECT severity, status FROM incidents WHERE service_id = $1 AND status <> 'resolved'`,
    [serviceId]
  );
  const next = deriveServiceStatus(rows[0].status, open);
  if (next !== rows[0].status) {
    await db.query(`UPDATE services SET status = $1 WHERE id = $2`, [next, serviceId]);
    fx.publish(rows[0].organization_id, { type: "service.updated", serviceId });
  }
}

export type NewIncident = {
  organizationId: number;
  serviceId: number | null;
  title: string;
  severity: IncidentSeverity;
  dedupKey: string | null;
  actor: Actor;
  openedBy: string; // human-readable cause for the timeline
};

// Opens an incident. Returns null — without side effects — when another
// transaction has just opened an incident for the same service + dedup key
// (the partial unique index incidents_open_dedup_idx arbitrates the race);
// the caller then groups its alert into that one instead.
export async function createIncident(db: PoolClient, fx: Effects, input: NewIncident) {
  const {
    rows: [{ incident_counter: number }],
  } = await db.query(
    `UPDATE organizations SET incident_counter = incident_counter + 1 WHERE id = $1 RETURNING incident_counter`,
    [input.organizationId]
  );

  // Level 1 of the service's escalation policy is due after its own delay
  // (normally 0 — page immediately). No policy, no escalation.
  const { rows } = await db.query<IncidentRow>(
    `INSERT INTO incidents (organization_id, number, service_id, title, severity, dedup_key,
                            created_by, commander_id, next_escalation_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7,
       (SELECT now() + make_interval(mins => r.delay_minutes)
        FROM services s JOIN escalation_rules r ON r.policy_id = s.escalation_policy_id
        WHERE s.id = $3 ORDER BY r.level LIMIT 1))
     ON CONFLICT (service_id, dedup_key) WHERE status <> 'resolved' AND dedup_key IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      input.organizationId,
      number,
      input.serviceId,
      input.title,
      input.severity,
      input.dedupKey,
      input.actor?.id ?? null,
    ]
  );
  const incident = rows[0];
  if (!incident) return null;

  if (input.actor) await addResponderRow(db, incident.id, input.actor.id, "commander");
  await addTimeline(db, fx, incident, "incident_created", `Incident opened ${input.openedBy}`, input.actor, {
    severity: incident.severity,
  });
  await recomputeServiceStatus(db, fx, incident.service_id);
  await audit(db, {
    organizationId: incident.organization_id,
    actorUserId: input.actor?.id ?? null,
    action: "incident.create",
    entityType: "incident",
    entityId: incident.id,
    details: { number: incident.number, severity: incident.severity, title: incident.title },
  });
  fx.publish(incident.organization_id, { type: "incident.created", incidentId: incident.id, number: incident.number });
  if (incident.next_escalation_at) fx.escalate(incident.id);
  return incident;
}

const STATUS_MESSAGES: Record<IncidentStatus, string> = {
  triggered: "Triggered",
  acknowledged: "Acknowledged",
  investigating: "Investigation started",
  mitigated: "Mitigated — customer impact stopped",
  resolved: "Resolved",
};

// The single place an incident's status changes. Validates the move against
// the state machine (on the row-locked incident), stamps timestamps, stops
// escalation once someone owns it, and on resolve notifies everyone who was
// paged and drafts the postmortem. Skipping ahead (triggered -> resolved)
// still stamps acknowledged/mitigated times as "no later than now", so
// metrics never have holes.
export async function changeStatus(
  db: PoolClient,
  fx: Effects,
  incident: IncidentRow,
  to: IncidentStatus,
  actor: Actor,
  message?: string
) {
  const from = incident.status;
  assertTransition(from, to);

  const { rows } = await db.query<IncidentRow>(
    `UPDATE incidents SET
       status = $2,
       acknowledged_at = CASE WHEN $2 IN ('acknowledged', 'investigating', 'mitigated') THEN COALESCE(acknowledged_at, now())
                              ELSE acknowledged_at END,
       mitigated_at = CASE WHEN $2 IN ('mitigated', 'resolved') THEN COALESCE(mitigated_at, now()) ELSE mitigated_at END,
       resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END,
       next_escalation_at = NULL,
       commander_id = COALESCE(commander_id, $3)
     WHERE id = $1
     RETURNING *`,
    [incident.id, to, actor?.id ?? null]
  );
  const updated = rows[0];

  if (actor) {
    await addResponderRow(db, incident.id, actor.id, updated.commander_id === actor.id ? "commander" : "responder");
  }

  const type: TimelineEventType = to === "acknowledged" ? "acknowledged" : to === "resolved" ? "resolved" : "status_changed";
  const base = STATUS_MESSAGES[to];
  await addTimeline(db, fx, updated, type, message ? `${base}: ${message}` : base, actor, { from, to });

  if (to === "resolved") {
    // Tell everyone who was paged that it's over.
    const { rows: notified } = await db.query<{ id: number }>(
      `INSERT INTO notifications (incident_id, user_id, kind)
       SELECT DISTINCT $1::int, user_id, 'resolved' FROM notifications
       WHERE incident_id = $1 AND kind IN ('triggered', 'escalated')
       RETURNING id`,
      [incident.id]
    );
    notified.forEach((n) => fx.deliverNotification(n.id));
    await generatePostmortem(db, fx, updated, actor, { onlyIfMissing: true });
  }

  await recomputeServiceStatus(db, fx, updated.service_id);
  await audit(db, {
    organizationId: updated.organization_id,
    actorUserId: actor?.id ?? null,
    action: `incident.${to}`,
    entityType: "incident",
    entityId: updated.id,
    details: { number: updated.number, from, to, message: message ?? null },
  });
  changed(fx, updated);
  return updated;
}

export async function changeSeverity(
  db: PoolClient,
  fx: Effects,
  incident: IncidentRow,
  severity: IncidentSeverity,
  actor: Actor,
  reason?: string
) {
  if (incident.severity === severity) return incident;
  const { rows } = await db.query<IncidentRow>(`UPDATE incidents SET severity = $2 WHERE id = $1 RETURNING *`, [
    incident.id,
    severity,
  ]);
  await addTimeline(
    db,
    fx,
    incident,
    "severity_changed",
    `Severity changed from ${incident.severity.toUpperCase()} to ${severity.toUpperCase()}${reason ? ` (${reason})` : ""}`,
    actor,
    { from: incident.severity, to: severity, ...(reason ? { reason } : {}) }
  );
  await recomputeServiceStatus(db, fx, incident.service_id);
  await audit(db, {
    organizationId: incident.organization_id,
    actorUserId: actor?.id ?? null,
    action: "incident.severity",
    entityType: "incident",
    entityId: incident.id,
    details: { from: incident.severity, to: severity, reason: reason ?? null },
  });
  changed(fx, rows[0]);
  return rows[0];
}

export async function addResponder(
  db: PoolClient,
  fx: Effects,
  incident: IncidentRow,
  user: { id: number; name: string },
  role: "commander" | "responder",
  actor: Actor
) {
  await addResponderRow(db, incident.id, user.id, role);
  if (role === "commander") {
    await db.query(
      `UPDATE incident_responders SET role = 'responder' WHERE incident_id = $1 AND user_id <> $2 AND role = 'commander'`,
      [incident.id, user.id]
    );
    await db.query(`UPDATE incidents SET commander_id = $2 WHERE id = $1`, [incident.id, user.id]);
    await addTimeline(db, fx, incident, "commander_assigned", `${user.name} is now incident commander`, actor, {
      userId: user.id,
    });
  } else {
    await addTimeline(db, fx, incident, "responder_added", `${user.name} joined as responder`, actor, {
      userId: user.id,
    });
  }
  await audit(db, {
    organizationId: incident.organization_id,
    actorUserId: actor?.id ?? null,
    action: "incident.responder",
    entityType: "incident",
    entityId: incident.id,
    details: { userId: user.id, role },
  });
  changed(fx, incident);
}

// Drafts (or refreshes) the postmortem from the incident's data. With
// onlyIfMissing it never touches an existing one (used on resolve); a manual
// regenerate refreshes metrics + timeline but keeps the narrative sections
// responders have already written.
export async function generatePostmortem(
  db: PoolClient,
  fx: Effects,
  incident: IncidentRow,
  actor: Actor,
  { onlyIfMissing = false } = {}
) {
  const { rows: existing } = await db.query(`SELECT id FROM postmortems WHERE incident_id = $1`, [incident.id]);
  if (existing.length && onlyIfMissing) return;

  const [{ rows: svc }, { rows: alerts }, { rows: timeline }, { rows: responders }] = await Promise.all([
    db.query(`SELECT name FROM services WHERE id = $1`, [incident.service_id]),
    db.query(
      `SELECT a.title, a.severity, a.source, a.received_at FROM alerts a
       JOIN incident_alerts ia ON ia.alert_id = a.id WHERE ia.incident_id = $1`,
      [incident.id]
    ),
    db.query(
      `SELECT t.type, t.message, t.created_at, u.name AS actor_name FROM timeline_events t
       LEFT JOIN users u ON u.id = t.actor_user_id WHERE t.incident_id = $1 ORDER BY t.created_at, t.id`,
      [incident.id]
    ),
    db.query(
      `SELECT u.name, r.role FROM incident_responders r JOIN users u ON u.id = r.user_id WHERE r.incident_id = $1`,
      [incident.id]
    ),
  ]);

  const draft = buildPostmortemDraft({
    incident: {
      number: incident.number,
      title: incident.title,
      severity: incident.severity,
      serviceName: svc[0]?.name ?? null,
      triggeredAt: incident.triggered_at,
      acknowledgedAt: incident.acknowledged_at,
      mitigatedAt: incident.mitigated_at,
      resolvedAt: incident.resolved_at,
    },
    alerts: alerts.map((a) => ({ title: a.title, severity: a.severity, source: a.source, receivedAt: a.received_at })),
    timeline: timeline.map((t) => ({ type: t.type, message: t.message, actorName: t.actor_name, createdAt: t.created_at })),
    responders: responders.map((r) => ({ name: r.name, role: r.role })),
  });

  if (existing.length) {
    await db.query(
      `UPDATE postmortems SET metrics = $2, timeline_markdown = $3, generated_at = now(), updated_at = now(),
              updated_by = $4
       WHERE incident_id = $1`,
      [incident.id, JSON.stringify(draft.metrics), draft.timelineMarkdown, actor?.id ?? null]
    );
  } else {
    await db.query(
      `INSERT INTO postmortems (incident_id, summary, impact, root_cause, resolution, action_items, metrics,
                                timeline_markdown, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        incident.id,
        draft.summary,
        draft.impact,
        draft.rootCause,
        draft.resolution,
        JSON.stringify(draft.actionItems),
        JSON.stringify(draft.metrics),
        draft.timelineMarkdown,
        actor?.id ?? null,
      ]
    );
  }
  await addTimeline(
    db,
    fx,
    incident,
    "postmortem_generated",
    existing.length ? "Postmortem metrics and timeline refreshed" : "Postmortem draft generated",
    actor
  );
}
