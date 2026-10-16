import { UnrecoverableError } from "bullmq";
import { publish, type WorkerContext } from "../context";
import { EvidenceStore } from "./evidence";
import { PermanentInvestigationError } from "./investigators";

// Job "investigate" { investigationId }: opens an evidence store scoped to
// the incident's organization, lets the investigator gather evidence and
// reason, and stores the validated findings with the evidence ledger and the
// trace of tool calls. It never writes to the incident or its timeline.
//
// Idempotent: an investigation that is no longer queued/running is left alone.
export async function runInvestigation(ctx: WorkerContext, investigationId: number, isFinalAttempt = true) {
  const { rows } = await ctx.pool.query<{ id: number; incident_id: number; organization_id: number; number: number }>(
    `UPDATE incident_investigations v SET status = 'running', started_at = now(), attempts = attempts + 1
     FROM incidents i
     WHERE v.id = $1 AND i.id = v.incident_id AND v.status IN ('queued', 'running')
     RETURNING v.id, v.incident_id, v.organization_id, i.number`,
    [investigationId]
  );
  const job = rows[0];
  if (!job) return { skipped: true as const };
  const notify = (status: string) =>
    publish(ctx, job.organization_id, { type: "investigation.updated", incidentId: job.incident_id, number: job.number, investigationId, status });
  await notify("running");

  const fail = async (message: string) => {
    await ctx.pool.query(`UPDATE incident_investigations SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`, [investigationId, message]);
    await notify("failed");
  };

  try {
    const store = await EvidenceStore.open(ctx.pool, job.incident_id);
    if (!store) throw new PermanentInvestigationError("Incident no longer exists");
    const result = await ctx.investigator.investigate(store);
    await ctx.pool.query(
      `UPDATE incident_investigations SET status = 'completed', provider = $2, model = $3, findings = $4, evidence = $5,
              steps = $6, warnings = $7, usage = $8, error = NULL, completed_at = now()
       WHERE id = $1 AND status = 'running'`,
      [
        investigationId,
        ctx.investigator.provider,
        result.model,
        JSON.stringify(result.findings),
        JSON.stringify(Object.fromEntries(store.ledger)),
        JSON.stringify(result.steps),
        JSON.stringify(result.warnings),
        result.usage ? JSON.stringify(result.usage) : null,
      ]
    );
    await notify("completed");
    return { skipped: false as const, hypotheses: result.findings.hypotheses.length, warnings: result.warnings.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PermanentInvestigationError) {
      await fail(message);
      throw new UnrecoverableError(message);
    }
    if (isFinalAttempt) await fail(message);
    else await ctx.pool.query(`UPDATE incident_investigations SET status = 'queued', error = $2 WHERE id = $1`, [investigationId, message]);
    throw err;
  }
}
