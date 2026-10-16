// Small helpers for degrading gracefully when a dependency is down.

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

// Rejects if `promise` hasn't settled within `ms`. The underlying work isn't
// cancelled — it may still finish later — so only wrap operations that are
// safe to complete late or twice (publishing an event, enqueuing a job with a
// fixed id, reading a counter).
//
// Why this is needed: ioredis queues commands while it is disconnected and
// BullMQ needs `maxRetriesPerRequest: null`, so during a Redis outage a
// command can wait indefinitely. Without a deadline, an alert that was
// already committed to Postgres would hang its HTTP response until Redis
// came back.
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// How long request-path Redis work may take before we carry on without it.
export const REDIS_DEADLINE_MS = 1_000;

// Logs a dependency failure at most once per `intervalMs` per label, so an
// outage under load doesn't produce one stack trace per request.
const lastLogged = new Map<string, number>();
export function logDegraded(label: string, err: unknown, intervalMs = 10_000) {
  const now = Date.now();
  if ((lastLogged.get(label) ?? 0) + intervalMs > now) return;
  lastLogged.set(label, now);
  console.error(`[degraded] ${label}: ${(err as Error)?.message ?? err}`);
}

// True once ioredis has lost its connection and not got it back. While
// that's the case, request-path Redis work is skipped straight away (fail
// open) instead of every request paying the full deadline: during an outage,
// alerts are answered as fast as Postgres allows.
//
// `status` alone isn't enough: between reconnect attempts it's
// "reconnecting", but during an attempt it's "connecting" — and on Windows a
// refused connection takes ~2 s to fail, so most of an outage looks like
// "connecting". So we remember connections that were lost (the 'close'
// event) until they're 'ready' again. A connection that is still being
// established at startup has never closed and goes through the deadline.
type TrackedRedis = { status: string; on(event: "close" | "ready", listener: () => void): unknown };
const tracked = new WeakSet<object>();
const lost = new WeakSet<object>();

export function trackRedis(redis: TrackedRedis) {
  if (tracked.has(redis)) return;
  tracked.add(redis);
  redis.on("close", () => lost.add(redis));
  redis.on("ready", () => lost.delete(redis));
}

export function redisIsDown(redis: TrackedRedis) {
  trackRedis(redis);
  if (redis.status === "ready") return false;
  return lost.has(redis) || redis.status === "reconnecting" || redis.status === "close" || redis.status === "end";
}

// Closes a Redis connection without hanging when the server is gone: QUIT
// is queued like any other command, so fall back to dropping the socket.
export async function closeRedis(redis: { quit(): Promise<unknown>; disconnect(): void }) {
  await withTimeout(redis.quit(), 1_000, "redis quit").catch(() => redis.disconnect());
}
