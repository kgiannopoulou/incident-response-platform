import { Router, type Request } from "express";
import type { InvestigationFindings } from "@irp/shared";
import type { Deps } from "../deps";
import { addTimeline, lockIncident } from "../domain/incidents";
import { assertCanAct } from "../domain/responders";
import { audit } from "../lib/audit";
import { runTx } from "../lib/effects";
import { HttpError, notFound, parseId } from "../lib/http";

// The AI Incident Investigator, on an incident:
//
//   GET  /incidents/:number/investigations                       latest first (findings, evidence, trace)
//   POST /incidents/:number/investigations                       start one (worker job) → 202
//   POST /incidents/:number/investigations/:id/hypotheses/:hid/post
//                                                                a responder posts a hypothesis to the
//                                                                timeline as their own note
//
// The investigation itself is read-only: it never changes the incident.
// Posting a hypothesis is a person's decision, attributed to them, with
// the evidence ids in the event's metadata.

const numberParam = (req: Request) => parseId(req.params.number, "Incident");

const COLUMNS = `v.id, v.status, v.provider, v.model, v.findings, v.evidence, v.steps, v.warnings, v.usage, v.error,
                 v.created_at, v.started_at, v.completed_at, u.name AS requested_by_name`;

export function investigationsRouter(deps: Deps) {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT ${COLUMNS} FROM incident_investigations v
       JOIN incidents i ON i.id = v.incident_id
       LEFT JOIN users u ON u.id = v.requested_by
       WHERE i.organization_id = $1 AND i.number = $2
       ORDER BY v.id DESC LIMIT 5`,
      [req.user!.organizationId, numberParam(req)]
    );
    res.json({ investigations: rows });
  });

  router.post("/", async (req, res) => {
    const investigation = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      const { rows } = await db.query<{ id: number; status: string }>(
        `INSERT INTO incident_investigations (organization_id, incident_id, requested_by) VALUES ($1, $2, $3)
         ON CONFLICT (incident_id) WHERE status IN ('queued', 'running') DO NOTHING
         RETURNING id, status`,
        [locked.organization_id, locked.id, req.user!.id]
      );
      if (!rows[0]) throw new HttpError(409, "An investigation of this incident is already running");
      await audit(db, {
        organizationId: locked.organization_id,
        actorUserId: req.user!.id,
        action: "incident.investigation_requested",
        entityType: "incident",
        entityId: locked.id,
        details: { investigationId: rows[0].id },
      });
      fx.investigate(rows[0].id);
      fx.publish(locked.organization_id, {
        type: "investigation.updated",
        incidentId: locked.id,
        number: locked.number,
        investigationId: rows[0].id,
        status: "queued",
      });
      return rows[0];
    });
    res.status(202).json({ investigation });
  });

  router.post("/:id/hypotheses/:hid/post", async (req, res) => {
    const investigationId = parseId(req.params.id, "Investigation");
    await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      await assertCanAct(db, locked, req.user!);
      const { rows } = await db.query<{ status: string; provider: string; findings: InvestigationFindings | null }>(
        `SELECT status, provider, findings FROM incident_investigations WHERE id = $1 AND incident_id = $2`,
        [investigationId, locked.id]
      );
      const inv = rows[0];
      if (!inv) throw notFound("Investigation");
      const hypothesis = inv.findings?.hypotheses.find((h) => h.id === req.params.hid);
      if (inv.status !== "completed" || !hypothesis) throw notFound("Hypothesis");
      const source = inv.provider === "claude" ? "AI investigator" : "Investigator (rules)";
      await addTimeline(
        db,
        fx,
        locked,
        "NOTE_ADDED",
        `${source} hypothesis (${hypothesis.confidence} confidence): ${hypothesis.title} — ${hypothesis.statement}`,
        { id: req.user!.id, name: req.user!.name },
        { investigationId, hypothesisId: hypothesis.id, evidenceIds: hypothesis.supportingEvidence, unconfirmed: true }
      );
      await audit(db, {
        organizationId: locked.organization_id,
        actorUserId: req.user!.id,
        action: "incident.investigation_hypothesis_posted",
        entityType: "incident",
        entityId: locked.id,
        details: { investigationId, hypothesisId: hypothesis.id },
      });
    });
    res.status(201).json({ ok: true });
  });

  return router;
}
