import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createPool } from "@irp/database";
import { QUEUES } from "@irp/shared";
import { createApp } from "./app";
import { env } from "./env";
import { RealtimeHub } from "./lib/realtime";

const pool = createPool(env.databaseUrl);
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
const subscriber = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
const connection = { url: env.redisUrl };
const queues = {
  notifications: new Queue(QUEUES.notifications, { connection }),
  escalations: new Queue(QUEUES.escalations, { connection }),
};
const hub = new RealtimeHub(subscriber);

const app = createApp({
  pool,
  redis,
  queues,
  hub,
  jwtSecret: env.jwtSecret,
  webOrigin: env.webOrigin,
  secureCookies: env.secureCookies,
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
  await Promise.all([queues.notifications.close(), queues.escalations.close()]);
  await redis.quit();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
