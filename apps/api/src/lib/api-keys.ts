import type { Pool } from "pg";
import type { PoolClient } from "@irp/database";
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey } from "@irp/shared/crypto";

// API keys authenticate machines (monitoring tools) sending alerts. Each key
// belongs to one service. The plaintext key is returned exactly once, when
// it is created; the database only ever sees its SHA-256 hash.

export type AuthenticatedKey = {
  keyId: number;
  rateLimitPerMinute: number;
  service: {
    id: number;
    organization_id: number;
    name: string;
    slug: string;
    status: string;
    auto_resolve: boolean;
  };
};

export type KeyLookup =
  | { ok: true; key: AuthenticatedKey }
  | { ok: false; reason: "unknown" | "revoked" | "expired" };

export async function authenticateApiKey(pool: Pool, rawKey: string): Promise<KeyLookup> {
  const { rows } = await pool.query(
    `SELECT k.id AS key_id, k.rate_limit_per_minute, k.revoked_at, k.last_used_at,
            (k.expires_at IS NOT NULL AND k.expires_at <= now()) AS expired,
            (k.last_used_at IS NULL OR k.last_used_at < now() - interval '60 seconds') AS stale_last_used,
            s.id, s.organization_id, s.name, s.slug, s.status, s.auto_resolve
     FROM api_keys k JOIN services s ON s.id = k.service_id
     WHERE k.key_hash = $1`,
    [hashApiKey(rawKey)]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.expired) return { ok: false, reason: "expired" };

  // last_used_at is written at most once a minute per key: a busy sender
  // would otherwise turn every alert into an extra row update (and lock).
  // Minute resolution is all "is this key still in use?" needs.
  if (row.stale_last_used) {
    await pool
      .query(
        `UPDATE api_keys SET last_used_at = now()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
        [row.key_id]
      )
      .catch((err) => console.error("Failed to record API key use:", err));
  }

  return {
    ok: true,
    key: {
      keyId: row.key_id,
      rateLimitPerMinute: row.rate_limit_per_minute,
      service: {
        id: row.id,
        organization_id: row.organization_id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        auto_resolve: row.auto_resolve,
      },
    },
  };
}

export type ApiKeyRow = {
  id: number;
  service_id: number;
  name: string;
  prefix: string;
  rate_limit_per_minute: number;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  replaced_by_id: number | null;
};

const KEY_COLUMNS = `id, service_id, name, prefix, rate_limit_per_minute, created_at, last_used_at,
                     expires_at, revoked_at, replaced_by_id`;

// Creates a key and returns the plaintext alongside the stored row. The
// caller hands the plaintext to the user once and never keeps it.
export async function createApiKey(
  db: PoolClient,
  input: { organizationId: number; serviceId: number; name: string; rateLimitPerMinute: number; createdBy: number | null }
) {
  const plaintext = generateApiKey();
  const { rows } = await db.query<ApiKeyRow>(
    `INSERT INTO api_keys (organization_id, service_id, name, prefix, key_hash, rate_limit_per_minute, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${KEY_COLUMNS}`,
    [
      input.organizationId,
      input.serviceId,
      input.name,
      apiKeyDisplayPrefix(plaintext),
      hashApiKey(plaintext),
      input.rateLimitPerMinute,
      input.createdBy,
    ]
  );
  return { key: rows[0], plaintext };
}

export async function listApiKeys(db: Pool | PoolClient, serviceId: number) {
  const { rows } = await db.query<ApiKeyRow & { created_by_name: string | null; revoked_by_name: string | null }>(
    `SELECT ${KEY_COLUMNS.split(",").map((c) => `k.${c.trim()}`).join(", ")},
            cu.name AS created_by_name, ru.name AS revoked_by_name
     FROM api_keys k
     LEFT JOIN users cu ON cu.id = k.created_by
     LEFT JOIN users ru ON ru.id = k.revoked_by
     WHERE k.service_id = $1
     ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC, k.id DESC`,
    [serviceId]
  );
  return rows.map((k) => ({ ...k, state: keyState(k) }));
}

export function keyState(k: Pick<ApiKeyRow, "revoked_at" | "expires_at">, now = new Date()) {
  if (k.revoked_at) return "revoked" as const;
  if (k.expires_at && k.expires_at <= now) return "expired" as const;
  if (k.expires_at) return "expiring" as const; // rotated; still accepted until expires_at
  return "active" as const;
}

export async function lockApiKey(db: PoolClient, serviceId: number, keyId: number) {
  const { rows } = await db.query<ApiKeyRow>(
    `SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = $1 AND service_id = $2 FOR NO KEY UPDATE`,
    [keyId, serviceId]
  );
  return rows[0] ?? null;
}

export { KEY_COLUMNS };
