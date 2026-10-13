import type { PoolClient } from "@irp/database";

// Writes one row to the organization-wide audit trail. Always called inside
// the same transaction as the change it describes, so the log can't claim
// something happened that was rolled back (or miss something that wasn't).
export async function audit(
  db: PoolClient,
  entry: {
    organizationId: number;
    actorUserId: number | null;
    action: string;
    entityType: string;
    entityId?: number | null;
    details?: Record<string, unknown>;
  }
) {
  await db.query(
    `INSERT INTO audit_log (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.organizationId,
      entry.actorUserId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      JSON.stringify(entry.details ?? {}),
    ]
  );
}
