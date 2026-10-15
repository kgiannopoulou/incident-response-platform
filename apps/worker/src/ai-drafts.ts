import { UnrecoverableError } from "bullmq";
import { aiContextDigest, loadAiPostmortemContext } from "@irp/database";
import { checkAiDraft } from "@irp/shared";
import { PermanentDraftError } from "./ai-drafter";
import { publish, type WorkerContext } from "./context";

// Job "draft-postmortem" { draftId }: builds the context from the source
// tables, asks the drafter, validates the answer and stores it as a
// suggestion. Nothing here writes to the postmortem itself — applying a
// suggestion is a person's decision (API: .../ai-drafts/:id/apply).
//
// Idempotent: a draft that is no longer queued/generating (finished,
// discarded, or picked up by another worker) is left alone.
export async function generateAiDraft(ctx: WorkerContext, draftId: number, isFinalAttempt = true) {
  const { rows } = await ctx.pool.query<{ id: number; incident_id: number; organization_id: number; number: number }>(
    `UPDATE postmortem_ai_drafts d SET status = 'generating', started_at = now(), attempts = attempts + 1
     FROM incidents i
     WHERE d.id = $1 AND i.id = d.incident_id AND d.status IN ('queued', 'generating')
     RETURNING d.id, d.incident_id, d.organization_id, i.number`,
    [draftId]
  );
  const draft = rows[0];
  if (!draft) return { skipped: true as const };
  const notify = () => publish(ctx, draft.organization_id, { type: "incident.updated", incidentId: draft.incident_id, number: draft.number });
  await notify();

  const fail = async (message: string) => {
    await ctx.pool.query(`UPDATE postmortem_ai_drafts SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`, [draftId, message]);
    await notify();
  };

  try {
    const context = await loadAiPostmortemContext(ctx.pool, draft.incident_id);
    if (!context) throw new PermanentDraftError("Incident no longer exists");
    const result = await ctx.drafter.draft(context);
    const { draft: checked, warnings } = checkAiDraft(result.output, context);
    await ctx.pool.query(
      `UPDATE postmortem_ai_drafts SET status = 'ready', provider = $2, model = $3, output = $4, warnings = $5,
              usage = $6, input_digest = $7, input_events = $8, error = NULL, completed_at = now()
       WHERE id = $1 AND status = 'generating'`,
      [
        draftId,
        ctx.drafter.provider,
        result.model,
        JSON.stringify(checked),
        JSON.stringify(warnings),
        result.usage ? JSON.stringify(result.usage) : null,
        aiContextDigest(context),
        context.timeline.length,
      ]
    );
    await notify();
    return { skipped: false as const, warnings: warnings.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PermanentDraftError) {
      await fail(message);
      throw new UnrecoverableError(message); // no point retrying
    }
    if (isFinalAttempt) await fail(message);
    else await ctx.pool.query(`UPDATE postmortem_ai_drafts SET status = 'queued', error = $2 WHERE id = $1`, [draftId, message]);
    throw err;
  }
}
