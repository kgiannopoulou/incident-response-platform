import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createPool } from "@irp/database";
import { QUEUES } from "@irp/shared";
import { createApp } from "./app";
import { env } from "./env";
import { RateLimiter } from "./lib/rate-limit";
import { RealtimeHub } from "./lib/realtime";

const pool = createPool(env.databaseUrl);
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
const subscriber = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
const connection = { url: env.redisUrl };
const queues = {
  notifications: new Queue(QUEUES.notifications, { connection }),
  escalations: new Queue(QUEUES.escalations, { connection }),
  webhooks: new Queue(QUEUES.webhooks, { connection }),
  deadLetter: new Queue(QUEUES.deadLetter, { connection }),
  aiDrafts: new Queue(QUEUES.aiDrafts, { connection }),
};
const hub = new RealtimeHub(subscriber, redis.duplicate());
const rateLimiter = new RateLimiter(redis, { authFailuresPerMinute: env.authFailuresPerMinute });

const app = createApp({
  pool,
  redis,
  queues,
  hub,
  rateLimiter,
  jwtSecret: env.jwtSecret,
  webOrigin: env.webOrigin,
  secureCookies: env.secureCookies,
  trustProxy: env.trustProxy,
  demo: { enabled: env.demoEnabled },
});

const server = app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
});

// Graceful shutdown: stop accepting connections, close SSE streams, then
// release Redis and Postgres.
async function shutdown() {
  console.log("Shutting down API...");
  await hub.close();
  server.close();
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await redis.quit();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
