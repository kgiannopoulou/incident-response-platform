import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createPool } from "@irp/database";
import { QUEUES } from "@irp/shared";
import { logConnection } from "@irp/shared/connection-log";
import { createApp } from "./app";
import { env } from "./env";
import { LoginThrottle, RateLimiter } from "./lib/rate-limit";
import { RealtimeHub } from "./lib/realtime";
import { closeRedis, withTimeout } from "./lib/resilience";

const pool = createPool(env.databaseUrl);
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
const subscriber = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
// ioredis reconnects on its own; log each outage once (see connection-log.ts).
logConnection("redis", redis, "alerts are still accepted; pages go out once it's back");
logConnection("redis:subscriber", subscriber);
const connection = { url: env.redisUrl };
const queues = {
  notifications: new Queue(QUEUES.notifications, { connection }),
  escalations: new Queue(QUEUES.escalations, { connection }),
  webhooks: new Queue(QUEUES.webhooks, { connection }),
  deadLetter: new Queue(QUEUES.deadLetter, { connection }),
  aiDrafts: new Queue(QUEUES.aiDrafts, { connection }),
  investigations: new Queue(QUEUES.investigations, { connection }),
};
for (const queue of Object.values(queues)) logConnection(`queue:${queue.name}`, queue);
const reader = redis.duplicate();
logConnection("redis:reader", reader);
const hub = new RealtimeHub(subscriber, reader);
const rateLimiter = new RateLimiter(redis, { authFailuresPerMinute: env.authFailuresPerMinute });
const loginThrottle = new LoginThrottle(redis);

const app = createApp({
  pool,
  redis,
  queues,
  hub,
  rateLimiter,
  loginThrottle,
  jwtSecret: env.jwtSecret,
  webOrigin: env.webOrigin,
  secureCookies: env.secureCookies,
  trustProxy: env.trustProxy,
  floodGuardPerMinute: env.floodGuardPerMinute,
  demo: { enabled: env.demoEnabled },
});

const server = app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
});

// Graceful shutdown: stop accepting connections, close SSE streams, let
// in-flight requests finish, then release Redis and Postgres. A dependency
// that is down must not keep the process alive: every step has a deadline,
// and after 10 s we exit regardless (Docker sends SIGKILL at 10 s anyway).
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down API...");
  setTimeout(() => process.exit(1), 10_000).unref();
  await hub.close();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all(Object.values(queues).map((q) => withTimeout(q.close(), 2_000, "queue close").catch(() => {})));
  await closeRedis(redis);
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
