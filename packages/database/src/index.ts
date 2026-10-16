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

// Failure handling (Phase 21):
// - connectionTimeoutMillis: while Postgres is down, a request fails within
//   5 s (and the API answers 503) instead of waiting forever for a client.
// - The 'error' listener: when Postgres restarts, idle pooled clients lose
//   their connection and the pool emits 'error'. Without a listener Node
//   treats that as an unhandled error event and the whole process exits —
//   the API would crash on a database failover. The pool discards the
//   broken client itself; we only log.
export function createPool(connectionString = databaseUrl(), options: pg.PoolConfig = {}) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000, ...options });
  pool.on("error", (err) => console.error(`[postgres] idle client error (discarded): ${err.message}`));
  return pool;
}

// Errors that mean "the database is unreachable right now", as opposed to a
// bad query: connection refused/reset/timed out, the server shutting down or
// starting up, or a client connection that was terminated mid-query. The API
// answers these with 503 + Retry-After so senders (and the SDK) retry.
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (starting up / recovery)
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "53300", // too_many_connections
]);

export function isDatabaseUnavailable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string; errors?: unknown[] };
  if (e.code && UNAVAILABLE_CODES.has(e.code)) return true;
  // AggregateError from net.connect when every resolved address refused.
  if (Array.isArray(e.errors) && e.errors.some(isDatabaseUnavailable)) return true;
  const message = e.message ?? "";
  return (
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("Connection terminated") ||
    message.includes("Client has encountered a connection error")
  );
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
    client.release();
    return result;
  } catch (err) {
    // If the connection itself broke, ROLLBACK fails too: Postgres rolls the
    // transaction back on its own when the session ends. Report the original
    // error, and destroy the client instead of returning it to the pool.
    const rollback = await client.query("ROLLBACK").then(
      () => null,
      (rollbackErr: Error) => rollbackErr
    );
    client.release(rollback ?? undefined);
    throw err;
  }
}

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");
export { runMigrations } from "./migrations";
export * from "./escalation";
export * from "./webhooks";
export * from "./ai-drafts";
