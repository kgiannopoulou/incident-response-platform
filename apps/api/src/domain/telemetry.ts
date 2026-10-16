import type { Pool } from "pg";
import { logFingerprint, type DeploymentPayload, type LogBatch } from "@irp/shared";
import type { IngestService } from "./ingestion";

// Change and log ingestion for the incident investigator. Both are plain
// inserts: no incidents are opened, nobody is paged. They are evidence the
// investigator correlates with alerts later (POST /deployments, POST /logs).

export async function recordDeployment(pool: Pool, service: IngestService, apiKeyId: number | null, d: DeploymentPayload) {
  const { rows } = await pool.query(
    `INSERT INTO deployments (organization_id, service_id, api_key_id, version, commit_sha, description, author, environment,
                              status, kind, url, metadata, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now()), $14)
     RETURNING id, version, status, kind, started_at, finished_at`,
    [
      service.organization_id,
      service.id,
      apiKeyId,
      d.version,
      d.commitSha ?? null,
      d.description,
      d.author ?? null,
      d.environment,
      d.status,
      d.kind,
      d.url ?? null,
      JSON.stringify(d.metadata),
      d.startedAt ?? null,
      d.finishedAt ?? (d.status === "in_progress" ? null : (d.startedAt ?? new Date().toISOString())),
    ]
  );
  const r = rows[0];
  return {
    id: `deploy_${r.id}`,
    service: service.slug,
    version: r.version,
    status: r.status,
    kind: r.kind,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

// One multi-row INSERT per batch (≤ 500 entries). Timestamps in the future
// are clamped to now, so a skewed client clock can't plant evidence "after"
// everything else.
export async function recordLogs(pool: Pool, service: IngestService, batch: LogBatch) {
  const now = Date.now();
  const values: unknown[] = [];
  const tuples = batch.entries.map((e, i) => {
    const ts = e.timestamp ? Math.min(Date.parse(e.timestamp), now) : now;
    values.push(new Date(ts), e.level, e.message, logFingerprint(e.message), JSON.stringify(e.attributes));
    const b = i * 5;
    return `($1, $2, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
  });
  await pool.query(
    `INSERT INTO log_events (organization_id, service_id, ts, level, message, fingerprint, attributes) VALUES ${tuples.join(", ")}`,
    [service.organization_id, service.id, ...values]
  );
  return { accepted: batch.entries.length, service: service.slug };
}
