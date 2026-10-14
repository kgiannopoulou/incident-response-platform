import type pg from "pg";
import { escalationDueAt, nextEscalationStep, type EscalationStepTiming } from "@irp/shared";

// Escalation data access shared by the API (manual "Escalate") and the
// worker (automatic escalation, acknowledgement timeouts), so both page a
// step in exactly the same way. Callers run these inside a transaction that
// already holds the incident's row lock.

type Db = pg.Pool | pg.PoolClient;

export async function loadEscalationSteps(db: Db, policyId: number): Promise<EscalationStepTiming[]> {
  const { rows } = await db.query<EscalationStepTiming>(
    `SELECT position, delay_minutes AS "delayMinutes" FROM escalation_steps WHERE policy_id = $1 ORDER BY position`,
    [policyId]
  );
  return rows;
}

// Everyone a step pages: its users plus the members of its teams, once each.
export async function escalationStepRecipients(db: Db, policyId: number, position: number) {
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT DISTINCT u.id, u.name
     FROM escalation_steps s
     JOIN escalation_step_targets t ON t.step_id = s.id
     LEFT JOIN team_members tm ON tm.team_id = t.team_id
     JOIN users u ON u.id = COALESCE(t.user_id, tm.user_id)
     WHERE s.policy_id = $1 AND s.position = $2
     ORDER BY u.name`,
    [policyId, position]
  );
  return rows;
}

// When the first step of a policy is due for an incident triggered now
// (null = no policy / no steps: nothing to page).
export async function firstEscalationAt(db: Db, policyId: number | null, triggeredAt: Date) {
  if (!policyId) return null;
  const first = nextEscalationStep(await loadEscalationSteps(db, policyId), 0);
  return first ? escalationDueAt(triggeredAt, first, triggeredAt) : null;
}

export type PagedStep = {
  level: number;
  recipients: { id: number; name: string }[];
  notificationIds: number[]; // rows created now; deliver them after COMMIT
  nextEscalationAt: Date | null;
};

// Pages the step after the incident's current escalation_level: one
// notification row per recipient (the unique index makes a retried step
// page nobody twice), then advances escalation_level and schedules the
// following step — only while the incident is still unacknowledged.
// Returns null when the policy has no further step. Pages are "triggered"
// for the first automatic step and "escalated" after that (and whenever a
// person escalates by hand).
export async function pageNextEscalationStep(
  db: pg.PoolClient,
  incident: { id: number; status: string; escalation_level: number; triggered_at: Date },
  policyId: number,
  { manual = false } = {}
): Promise<PagedStep | null> {
  const steps = await loadEscalationSteps(db, policyId);
  const step = nextEscalationStep(steps, incident.escalation_level);
  if (!step) return null;

  const recipients = await escalationStepRecipients(db, policyId, step.position);
  const kind = incident.escalation_level === 0 && !manual ? "triggered" : "escalated";
  const notificationIds: number[] = [];
  for (const user of recipients) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO notifications (incident_id, user_id, kind, escalation_level) VALUES ($1, $2, $3, $4)
       ON CONFLICT (incident_id, user_id, kind, escalation_level) DO NOTHING RETURNING id`,
      [incident.id, user.id, kind, step.position]
    );
    if (rows[0]) notificationIds.push(rows[0].id);
  }

  const following = nextEscalationStep(steps, step.position);
  const nextEscalationAt =
    incident.status === "triggered" && following ? escalationDueAt(incident.triggered_at, following) : null;
  await db.query(`UPDATE incidents SET escalation_level = $2, next_escalation_at = $3 WHERE id = $1`, [
    incident.id,
    step.position,
    nextEscalationAt,
  ]);
  return { level: step.position, recipients, notificationIds, nextEscalationAt };
}
