import { Router, type Request } from "express";
import {
  aiDraftToPostmortemFields,
  applyAiDraftSchema,
  incidentRef,
  mergeActionItems,
  newActionItemId,
  UNCONFIRMED_ROOT_CAUSE,
  type AiPostmortemOutput,
  type AiSection,
  renderPostmortemMarkdown,
  updateActionItemSchema,
  updatePostmortemSchema,
  type ActionItem,
  type PostmortemTimelineEntry,
} from "@irp/shared";
import type { PoolClient } from "@irp/database";
import type { Deps } from "../deps";
import { addTimeline, generatePostmortem, lockIncident } from "../domain/incidents";
import { audit } from "../lib/audit";
import { runTx } from "../lib/effects";
import { HttpError, notFound, parseId } from "../lib/http";

// Postmortems, keyed by incident number:
//
//   GET   /postmortems                                   every postmortem, with action-item progress
//   GET   /incidents/:number/postmortem                  the document
//   POST  /incidents/:number/postmortem                  draft it (or refresh metrics + timeline)
//   PUT   /incidents/:number/postmortem                  edit sections / action items / hidden entries, publish
//   PATCH /incidents/:number/postmortem/action-items/:id tick off one action item (also once published)
//   GET   /incidents/:number/postmortem/markdown         export as a Markdown document
//
// AI-assisted drafting (phase 16) — suggestions, never edits on their own:
//
//   GET   /incidents/:number/postmortem/ai-drafts                    recent drafts, newest first
//   POST  /incidents/:number/postmortem/ai-drafts                    request one (worker job)
//   POST  /incidents/:number/postmortem/ai-drafts/:id/apply          copy chosen sections into the postmortem
//   POST  /incidents/:number/postmortem/ai-drafts/:id/discard
//
// Applied sections are marked as AI-assisted and must be reviewed: the
// reviewer confirms with `aiReviewed: true`, and an "[Unconfirmed AI
// hypothesis …]" root cause blocks publishing until a person rewrites it.
//
// Publishing freezes the narrative: further edits need `status: "draft"`
// (reopen). Action items stay updatable, because follow-up work happens
// after the review meeting.

const numberParam = (req: Request) => parseId(req.params.number, "Incident");

type Db = Pick<PoolClient, "query">;

async function loadPostmortem(db: Db, organizationId: number, number: number) {
  const { rows } = await db.query(
    `SELECT p.*, i.number, i.title, i.severity, i.status AS incident_status, i.triggered_at, i.resolved_at,
            s.name AS service_name, u.name AS updated_by_name, pu.name AS published_by_name,
            ar.name AS ai_reviewed_by_name
     FROM postmortems p
     JOIN incidents i ON i.id = p.incident_id
     LEFT JOIN services s ON s.id = i.service_id
     LEFT JOIN users u ON u.id = p.updated_by
     LEFT JOIN users pu ON pu.id = p.published_by
     LEFT JOIN users ar ON ar.id = p.ai_reviewed_by
     WHERE i.organization_id = $1 AND i.number = $2`,
    [organizationId, number]
  );
  if (!rows[0]) throw notFound("Postmortem");
  return rows[0];
}

const NARRATIVE_FIELDS = ["summary", "impact", "rootCause", "resolution", "whatWentWell", "whatWentPoorly", "actionItems", "hiddenTimelineEventIds"] as const;
const ROOT_CAUSE_PLACEHOLDER = "Replace this with the confirmed root cause";

export function postmortemListRouter(deps: Deps) {
  const router = Router();
  router.get("/", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT i.number, i.title, i.severity, s.name AS service_name, p.status, p.updated_at, p.published_at,
              (p.metrics->>'durationSeconds')::int AS duration_seconds,
              jsonb_array_length(p.action_items) AS action_items_total,
              (SELECT count(*)::int FROM jsonb_array_elements(p.action_items) a WHERE (a->>'done')::boolean) AS action_items_done
       FROM postmortems p
       JOIN incidents i ON i.id = p.incident_id
       LEFT JOIN services s ON s.id = i.service_id
       WHERE i.organization_id = $1
       ORDER BY i.triggered_at DESC LIMIT 200`,
      [req.user!.organizationId]
    );
    res.json({ postmortems: rows });
  });
  return router;
}

// Mounted at /incidents/:number/postmortem (mergeParams for :number).
export function postmortemRouter(deps: Deps) {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    res.json({ postmortem: await loadPostmortem(deps.pool, req.user!.organizationId, numberParam(req)) });
  });

  router.get("/markdown", async (req, res) => {
    const pm = await loadPostmortem(deps.pool, req.user!.organizationId, numberParam(req));
    const markdown = renderPostmortemMarkdown({
      number: pm.number,
      title: pm.title,
      severity: pm.severity,
      serviceName: pm.service_name,
      status: pm.status,
      triggeredAt: pm.triggered_at,
      resolvedAt: pm.resolved_at,
      summary: pm.summary,
      impact: pm.impact,
      rootCause: pm.root_cause,
      resolution: pm.resolution,
      whatWentWell: pm.what_went_well,
      whatWentPoorly: pm.what_went_poorly,
      actionItems: pm.action_items,
      metrics: pm.metrics,
      timeline: pm.timeline,
      aiAssisted: pm.ai_assisted_sections.length ? { sections: pm.ai_assisted_sections, reviewedBy: pm.ai_reviewed_by_name } : undefined,
    });
    res
      .type("text/markdown; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${incidentRef(pm.number)}-postmortem.md"`)
      .send(markdown);
  });

  // Draft it now (or refresh its metrics/timeline). Only for resolved
  // incidents: the metrics aren't final before that.
  router.post("/", async (req, res) => {
    await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      if (locked.status !== "resolved") {
        throw new HttpError(409, "Resolve the incident before generating its postmortem");
      }
      await generatePostmortem(db, fx, locked, { id: req.user!.id, name: req.user!.name });
      await audit(db, {
        organizationId: locked.organization_id,
        actorUserId: req.user!.id,
        action: "postmortem.generate",
        entityType: "incident",
        entityId: locked.id,
      });
    });
    res.status(201).json({ ok: true });
  });

  router.put("/", async (req, res) => {
    const data = updatePostmortemSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const postmortem = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, orgId, numberParam(req));
      const { rows } = await db.query<{
        status: string;
        root_cause: string;
        timeline: PostmortemTimelineEntry[];
        ai_review_pending: boolean;
      }>(
        `SELECT status, root_cause, timeline, ai_review_pending FROM postmortems WHERE incident_id = $1 FOR UPDATE`,
        [locked.id]
      );
      const current = rows[0];
      if (!current) throw notFound("Postmortem");

      const editsContent = NARRATIVE_FIELDS.some((f) => data[f] !== undefined);
      if (current.status === "published" && editsContent && data.status !== "draft") {
        throw new HttpError(409, "Published postmortems are read-only — reopen it as a draft to edit");
      }
      const publishing = data.status === "published" && current.status !== "published";
      if (publishing && (data.rootCause ?? current.root_cause).includes(ROOT_CAUSE_PLACEHOLDER)) {
        throw new HttpError(422, "Write the confirmed root cause before publishing");
      }
      // AI-assisted text is a draft until a person says otherwise.
      if (publishing && current.ai_review_pending && !data.aiReviewed) {
        throw new HttpError(422, "Review the AI-drafted sections and confirm the review before publishing");
      }
      if (publishing && (data.rootCause ?? current.root_cause).includes(UNCONFIRMED_ROOT_CAUSE)) {
        throw new HttpError(422, "The root cause is still an unconfirmed AI hypothesis — verify it and remove the marker before publishing");
      }

      const actionItems: ActionItem[] | undefined = data.actionItems?.map((a) => ({ ...a, id: a.id ?? newActionItemId() }));
      const timeline = data.hiddenTimelineEventIds
        ? current.timeline.map((e) => ({ ...e, hidden: e.eventId !== null && data.hiddenTimelineEventIds!.includes(e.eventId) }))
        : undefined;

      await db.query(
        `UPDATE postmortems SET
           summary = COALESCE($2, summary),
           impact = COALESCE($3, impact),
           root_cause = COALESCE($4, root_cause),
           resolution = COALESCE($5, resolution),
           what_went_well = COALESCE($6, what_went_well),
           what_went_poorly = COALESCE($7, what_went_poorly),
           action_items = COALESCE($8, action_items),
           timeline = COALESCE($9, timeline),
           status = COALESCE($10, status),
           published_at = CASE WHEN $10 = 'published' THEN COALESCE(published_at, now())
                               WHEN $10 = 'draft' THEN NULL ELSE published_at END,
           published_by = CASE WHEN $10 = 'published' THEN COALESCE(published_by, $11)
                               WHEN $10 = 'draft' THEN NULL ELSE published_by END,
           ai_review_pending = CASE WHEN $12 THEN false ELSE ai_review_pending END,
           ai_reviewed_by = CASE WHEN $12 THEN $11 ELSE ai_reviewed_by END,
           ai_reviewed_at = CASE WHEN $12 THEN now() ELSE ai_reviewed_at END,
           updated_at = now(),
           updated_by = $11
         WHERE incident_id = $1`,
        [
          locked.id,
          data.summary ?? null,
          data.impact ?? null,
          data.rootCause ?? null,
          data.resolution ?? null,
          data.whatWentWell ?? null,
          data.whatWentPoorly ?? null,
          actionItems ? JSON.stringify(actionItems) : null,
          timeline ? JSON.stringify(timeline) : null,
          data.status ?? null,
          req.user!.id,
          data.aiReviewed === true && current.ai_review_pending,
        ]
      );
      if (publishing) {
        await addTimeline(db, fx, locked, "POSTMORTEM_PUBLISHED", "Postmortem published", { id: req.user!.id, name: req.user!.name });
      }
      await audit(db, {
        organizationId: locked.organization_id,
        actorUserId: req.user!.id,
        action: publishing ? "postmortem.publish" : data.aiReviewed && current.ai_review_pending ? "postmortem.ai_reviewed" : data.status === "draft" && current.status === "published" ? "postmortem.reopen" : "postmortem.update",
        entityType: "incident",
        entityId: locked.id,
        details: { fields: Object.keys(data) },
      });
      fx.publish(locked.organization_id, { type: "incident.updated", incidentId: locked.id, number: locked.number });
      return loadPostmortem(db, orgId, locked.number);
    });
    res.json({ postmortem });
  });

  router.patch("/action-items/:itemId", async (req, res) => {
    const data = updateActionItemSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const item = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, orgId, numberParam(req));
      const { rows } = await db.query<{ action_items: ActionItem[] }>(
        `SELECT action_items FROM postmortems WHERE incident_id = $1 FOR UPDATE`,
        [locked.id]
      );
      if (!rows[0]) throw notFound("Postmortem");
      const items = rows[0].action_items;
      const index = items.findIndex((a) => a.id === req.params.itemId);
      if (index < 0) throw notFound("Action item");
      const updated = { ...items[index], ...data };
      items[index] = updated;
      await db.query(`UPDATE postmortems SET action_items = $2, updated_at = now(), updated_by = $3 WHERE incident_id = $1`, [
        locked.id,
        JSON.stringify(items),
        req.user!.id,
      ]);
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "postmortem.action_item",
        entityType: "incident",
        entityId: locked.id,
        details: { itemId: updated.id, ...data },
      });
      fx.publish(orgId, { type: "incident.updated", incidentId: locked.id, number: locked.number });
      return updated;
    });
    res.json({ actionItem: item });
  });

  // ---- AI-assisted drafts -------------------------------------------------

  const DRAFT_COLUMNS = `d.id, d.status, d.provider, d.model, d.output, d.warnings, d.usage, d.error, d.attempts,
    d.applied_sections, d.input_digest, d.input_events, d.created_at, d.completed_at, d.reviewed_at,
    ru.name AS requested_by_name, rv.name AS reviewed_by_name`;

  router.get("/ai-drafts", async (req, res) => {
    const { rows } = await deps.pool.query(
      `SELECT ${DRAFT_COLUMNS} FROM postmortem_ai_drafts d
       JOIN incidents i ON i.id = d.incident_id
       LEFT JOIN users ru ON ru.id = d.requested_by
       LEFT JOIN users rv ON rv.id = d.reviewed_by
       WHERE i.organization_id = $1 AND i.number = $2
       ORDER BY d.id DESC LIMIT 5`,
      [req.user!.organizationId, numberParam(req)]
    );
    res.json({ drafts: rows });
  });

  router.post("/ai-drafts", async (req, res) => {
    const draft = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, req.user!.organizationId, numberParam(req));
      if (locked.status !== "resolved") throw new HttpError(409, "Resolve the incident before drafting its postmortem");
      const { rows: pm } = await db.query<{ status: string }>(`SELECT status FROM postmortems WHERE incident_id = $1`, [locked.id]);
      if (!pm[0]) throw notFound("Postmortem");
      if (pm[0].status === "published") throw new HttpError(409, "Published postmortems are read-only — reopen it as a draft first");
      const { rows } = await db.query<{ id: number; status: string }>(
        `INSERT INTO postmortem_ai_drafts (organization_id, incident_id, requested_by) VALUES ($1, $2, $3)
         ON CONFLICT (incident_id) WHERE status IN ('queued', 'generating') DO NOTHING
         RETURNING id, status`,
        [locked.organization_id, locked.id, req.user!.id]
      );
      if (!rows[0]) throw new HttpError(409, "A draft for this postmortem is already being generated");
      await audit(db, {
        organizationId: locked.organization_id,
        actorUserId: req.user!.id,
        action: "postmortem.ai_draft_requested",
        entityType: "incident",
        entityId: locked.id,
        details: { draftId: rows[0].id },
      });
      fx.generateAiDraft(rows[0].id);
      fx.publish(locked.organization_id, { type: "incident.updated", incidentId: locked.id, number: locked.number });
      return rows[0];
    });
    res.status(202).json({ draft });
  });

  // Loads one of this incident's drafts, row-locked for the transaction.
  async function lockDraft(db: PoolClient, incidentId: number, draftId: number) {
    const { rows } = await db.query<{ id: number; status: string; output: AiPostmortemOutput | null; applied_sections: string[] }>(
      `SELECT id, status, output, applied_sections FROM postmortem_ai_drafts WHERE id = $1 AND incident_id = $2 FOR UPDATE`,
      [draftId, incidentId]
    );
    if (!rows[0]) throw notFound("AI draft");
    return rows[0];
  }

  // Copies the chosen sections into the postmortem. Narrative fields are
  // replaced (the reviewer picked them over the current text), suggested
  // action items are appended. Timeline and metrics are never touched.
  router.post("/ai-drafts/:draftId/apply", async (req, res) => {
    const { sections } = applyAiDraftSchema.parse(req.body);
    const orgId = req.user!.organizationId;
    const postmortem = await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, orgId, numberParam(req));
      const draft = await lockDraft(db, locked.id, parseId(req.params.draftId, "AI draft"));
      if (!draft.output || !["ready", "applied"].includes(draft.status)) {
        throw new HttpError(409, `This draft can't be applied (it is ${draft.status})`);
      }
      const { rows } = await db.query<{ status: string; action_items: ActionItem[]; ai_assisted_sections: string[] }>(
        `SELECT status, action_items, ai_assisted_sections FROM postmortems WHERE incident_id = $1 FOR UPDATE`,
        [locked.id]
      );
      if (!rows[0]) throw notFound("Postmortem");
      if (rows[0].status === "published") throw new HttpError(409, "Published postmortems are read-only — reopen it as a draft first");

      const fields = aiDraftToPostmortemFields(draft.output, sections as AiSection[], newActionItemId);
      const actionItems = fields.actionItems ? mergeActionItems(rows[0].action_items, fields.actionItems) : null;
      const assisted = [...new Set([...rows[0].ai_assisted_sections, ...sections])];
      await db.query(
        `UPDATE postmortems SET
           summary = COALESCE($2, summary),
           impact = COALESCE($3, impact),
           root_cause = COALESCE($4, root_cause),
           resolution = COALESCE($5, resolution),
           what_went_well = COALESCE($6, what_went_well),
           what_went_poorly = COALESCE($7, what_went_poorly),
           action_items = COALESCE($8, action_items),
           ai_assisted_sections = $9,
           ai_review_pending = true,
           ai_reviewed_by = NULL,
           ai_reviewed_at = NULL,
           updated_at = now(),
           updated_by = $10
         WHERE incident_id = $1`,
        [
          locked.id,
          fields.summary ?? null,
          fields.impact ?? null,
          fields.rootCause ?? null,
          fields.resolution ?? null,
          fields.whatWentWell ?? null,
          fields.whatWentPoorly ?? null,
          actionItems ? JSON.stringify(actionItems) : null,
          assisted,
          req.user!.id,
        ]
      );
      await db.query(
        `UPDATE postmortem_ai_drafts SET status = 'applied', applied_sections = $2, reviewed_by = $3, reviewed_at = now()
         WHERE id = $1`,
        [draft.id, [...new Set([...draft.applied_sections, ...sections])], req.user!.id]
      );
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "postmortem.ai_draft_applied",
        entityType: "incident",
        entityId: locked.id,
        details: { draftId: draft.id, sections },
      });
      fx.publish(orgId, { type: "incident.updated", incidentId: locked.id, number: locked.number });
      return loadPostmortem(db, orgId, locked.number);
    });
    res.json({ postmortem });
  });

  router.post("/ai-drafts/:draftId/discard", async (req, res) => {
    const orgId = req.user!.organizationId;
    await runTx(deps, async (db, fx) => {
      const locked = await lockIncident(db, orgId, numberParam(req));
      const draft = await lockDraft(db, locked.id, parseId(req.params.draftId, "AI draft"));
      if (draft.status === "queued" || draft.status === "generating") throw new HttpError(409, "Wait for the draft to finish first");
      await db.query(`UPDATE postmortem_ai_drafts SET status = 'discarded', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [
        draft.id,
        req.user!.id,
      ]);
      await audit(db, {
        organizationId: orgId,
        actorUserId: req.user!.id,
        action: "postmortem.ai_draft_discarded",
        entityType: "incident",
        entityId: locked.id,
        details: { draftId: draft.id },
      });
      fx.publish(orgId, { type: "incident.updated", incidentId: locked.id, number: locked.number });
    });
    res.status(204).end();
  });

  return router;
}
