import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";

// One .env at the repository root configures every app and script. Values
// already present in the environment (CI, Docker) take precedence.
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });

export type { PoolClient } from "pg";

export function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing required environment variable: DATABASE_URL");
  return url;
}

export function createPool(connectionString = databaseUrl()) {
  return new pg.Pool({ connectionString, max: 10 });
}

// Runs `fn` inside BEGIN/COMMIT on a dedicated client, rolling back on any
// error. Every multi-statement write in the API and worker goes through
// this so a half-applied change (an incident without its timeline event,
// say) can never be committed.
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");
export { runMigrations } from "./migrations";
export * from "./escalation";
