import { Router } from "express";
import type { PoolClient } from "@irp/database";
import { escalationPolicySchema, type EscalationPolicyInput } from "@irp/shared";
import type { Deps } from "../deps";
import { audit } from "../lib/audit";
import { requireAdmin } from "../lib/auth";
import { runTx } from "../lib/effects";
import { HttpError, notFound, parseId } from "../lib/http";

// Escalation policies: ordered steps, each paging users and/or teams a
// number of minutes after an incident triggers if nobody has acknowledged.
//
//   GET    /escalation-policies        every policy with steps, targets, services
//   GET    /escalation-policies/:id
//   POST   /escalation-policies        (admin) create
//   PUT    /escalation-policies/:id    (admin) replace name, description and all steps
//   DELETE /escalation-policies/:id    (admin) only when no service uses it
//
// Steps are always replaced as a whole, in one transaction: a policy is
// small, and "the policy is exactly this list" is far easier to reason about
// (and to audit) than per-step PATCHes that can leave gaps in the order.

type Db = Pick<PoolClient, "query">;

async function loadPolicies(db: Db, organizationId: number, policyId: number | null = null) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
       COALESCE((
         SELECT json_agg(json_build_object(
           'position', s.position,
           'delayMinutes', s.delay_minutes,
           'targets', (
             SELECT COALESCE(json_agg(json_build_object(
               'targetType', t.target_type,
               'targetId', COALESCE(t.user_id, t.team_id),
               'name', COALESCE(u.name, tm.name)) ORDER BY t.target_type DESC, COALESCE(u.name, tm.name)), '[]')
             FROM escalation_step_targets t
             LEFT JOIN users u ON u.id = t.user_id
             LEFT JOIN teams tm ON tm.id = t.team_id
             WHERE t.step_id = s.id)
         ) ORDER BY s.position)
         FROM escalation_steps s WHERE s.policy_id = p.id), '[]') AS steps,
       COALESCE((
         SELECT json_agg(json_build_object('id', sv.id, 'name', sv.name) ORDER BY sv.name)
         FROM services sv WHERE sv.escalation_policy_id = p.id), '[]') AS services
     FROM escalation_policies p
     WHERE p.organization_id = $1 AND ($2::int IS NULL OR p.id = $2)
     ORDER BY p.name`,
    [organizationId, policyId]
  );
  return rows;
}

// Every user/team a policy targets must belong to the caller's organization.
async function assertTargetsInOrg(db: Db, organizationId: number, policy: EscalationPolicyInput) {
  const targets = policy.steps.flatMap((s) => s.targets);
  const userIds = [...new Set(targets.filter((t) => t.targetType === "user").map((t) => t.targetId))];
  const teamIds = [...new Set(targets.filter((t) => t.targetType === "team").map((t) => t.targetId))];
  const { rows } = await db.query<{ users: number; teams: number }>(
    `SELECT
       (SELECT count(*)::int FROM organization_members WHERE organization_id = $1 AND user_id = ANY($2::int[])) AS users,
       (SELECT count(*)::int FROM teams WHERE organization_id = $1 AND id = ANY($3::int[])) AS teams`,
    [organizationId, userIds, teamIds]
  );
  if (rows[0].users !== userIds.length) throw new HttpError(400, "Unknown user in escalation targets");
  if (rows[0].teams !== teamIds.length) throw new HttpError(400, "Unknown team in escalation targets");
}

async function writeSteps(db: Db, policyId: number, policy: EscalationPolicyInput) {
  await db.query(`DELETE FROM escalation_steps WHERE policy_id = $1`, [policyId]);
  for (const [i, step] of policy.steps.entries()) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO escalation_steps (policy_id, position, delay_minutes) VALUES ($1, $2, $3) RETURNING id`,
      [policyId, i + 1, step.delayMinutes]
    );
    for (const target of step.targets) {
      await db.query(
        `INSERT INTO escalation_step_targets (step_id, target_type, user_id, team_id) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, target.targetType, target.targetType === "user" ? target.targetId : null, target.targetType === "team" ? target.targetId : null]
      );
    }
  }
}

const summary = (policy: EscalationPolicyInput) => ({
  name: policy.name,
  steps: policy.steps.map((s) => ({ delayMinutes: s.delayMinutes, targets: s.targets.length })),
});

export function escalationPoliciesRouter(deps: Deps) {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ policies: await loadPolicies(deps.pool, req.user!.organizationId) });
  });

  router.get("/:id", async (req, res) => {
    const [policy] = await loadPolicies(deps.pool, req.user!.organizationId, parseId(req.params.id, "Escalation policy"));
    if (!policy) throw notFound("Escalation policy");
    res.json({ policy });
  });

  router.post("/", requireAdmin, async (req, res) => {
    const data = escalationPolicySchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const policy = await runTx(deps, async (db) => {
      await assertTargetsInOrg(db, orgId, data);
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO escalation_policies (organization_id, name, description) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, name) DO NOTHING RETURNING id`,
        [orgId, data.name, data.description]
      );
      if (!rows[0]) throw new HttpError(409, `An escalation policy named "${data.name}" already exists`);
      await writeSteps(db, rows[0].id, data);
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "escalation_policy.create",
        entityType: "escalation_policy",
        entityId: rows[0].id,
        details: summary(data),
      });
      return (await loadPolicies(db, orgId, rows[0].id))[0];
    });
    res.status(201).json({ policy });
  });

  router.put("/:id", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, "Escalation policy");
    const data = escalationPolicySchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const policy = await runTx(deps, async (db) => {
      const { rows } = await db.query(
        `SELECT id FROM escalation_policies WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [id, orgId]
      );
      if (!rows[0]) throw notFound("Escalation policy");
      await assertTargetsInOrg(db, orgId, data);
      const { rows: clash } = await db.query(
        `SELECT 1 FROM escalation_policies WHERE organization_id = $1 AND name = $2 AND id <> $3`,
        [orgId, data.name, id]
      );
      if (clash[0]) throw new HttpError(409, `An escalation policy named "${data.name}" already exists`);
      await db.query(`UPDATE escalation_policies SET name = $2, description = $3, updated_at = now() WHERE id = $1`, [
        id,
        data.name,
        data.description,
      ]);
      await writeSteps(db, id, data);
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "escalation_policy.update",
        entityType: "escalation_policy",
        entityId: id,
        details: summary(data),
      });
      return (await loadPolicies(db, orgId, id))[0];
    });
    res.json({ policy });
  });

  router.delete("/:id", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id, "Escalation policy");
    const orgId = req.user!.organizationId;
    await runTx(deps, async (db) => {
      const { rows } = await db.query<{ name: string }>(
        `SELECT name FROM escalation_policies WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [id, orgId]
      );
      if (!rows[0]) throw notFound("Escalation policy");
      const { rows: users } = await db.query<{ name: string }>(
        `SELECT name FROM services WHERE escalation_policy_id = $1 ORDER BY name`,
        [id]
      );
      if (users.length) {
        throw new HttpError(409, `Still used by ${users.map((s) => s.name).join(", ")} — assign another policy first`);
      }
      await db.query(`DELETE FROM escalation_policies WHERE id = $1`, [id]);
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "escalation_policy.delete",
        entityType: "escalation_policy",
        entityId: id,
        details: { name: rows[0].name },
      });
    });
    res.status(204).end();
  });

  return router;
}
