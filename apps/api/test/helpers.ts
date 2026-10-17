import { Queue } from "bullmq";
import { Redis } from "ioredis";
import request from "supertest";
import { resetFixtures, setupTestDatabase, TEST_PASSWORD, type Fixtures } from "@irp/database/testing";
import { QUEUES } from "@irp/shared";
import { createApp } from "../src/app";
import type { Deps } from "../src/deps";
import { IngestionStats } from "../src/lib/ingestion-stats";
import { LoginThrottle, RateLimiter } from "../src/lib/rate-limit";
import { RealtimeHub } from "../src/lib/realtime";

// Tests use Redis logical database 1 so they never touch a dev worker's queues.
export function testRedisUrl() {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6380");
  url.pathname = "/1";
  return url.toString();
}

export async function createTestContext() {
  const pool = await setupTestDatabase();
  const redisUrl = testRedisUrl();
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const connection = { url: redisUrl };
  const queues = {
    notifications: new Queue(QUEUES.notifications, { connection }),
    escalations: new Queue(QUEUES.escalations, { connection }),
    webhooks: new Queue(QUEUES.webhooks, { connection }),
    deadLetter: new Queue(QUEUES.deadLetter, { connection }),
    aiDrafts: new Queue(QUEUES.aiDrafts, { connection }),
    investigations: new Queue(QUEUES.investigations, { connection }),
  };
  const hub = new RealtimeHub(
    new Redis(redisUrl, { maxRetriesPerRequest: null }),
    new Redis(redisUrl, { maxRetriesPerRequest: null })
  );
  const deps: Deps = {
    pool,
    redis,
    queues,
    hub,
    rateLimiter: new RateLimiter(redis, { authFailuresPerMinute: 20 }),
    loginThrottle: new LoginThrottle(redis),
    floodGuardPerMinute: 100_000, // the suites fire thousands of requests; security.test.ts tests the guard itself
    jwtSecret: "test-secret",
    webOrigin: "http://localhost:3000",
    secureCookies: false,
    demo: { enabled: true, timeScale: 0 },
    ingestionStats: new IngestionStats(),
  };
  const app = createApp(deps);
  let fixtures!: Fixtures;

  return {
    app,
    deps,
    get fx() {
      return fixtures;
    },
    async reset() {
      fixtures = await resetFixtures(pool);
      await redis.flushdb();
    },
    // Logs in and returns an Authorization header for that user.
    async as(name: "alex" | "sam" | "jordan" | "eve") {
      const res = await request(app).post("/api/v1/auth/login").send({ email: `${name}@test.dev`, password: TEST_PASSWORD });
      if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
      return { Authorization: `Bearer ${res.body.token}` };
    },
    alert(key: string, body: Record<string, unknown>) {
      return request(app).post("/api/v1/alerts").set("Authorization", `Bearer ${key}`).send(body);
    },
    async close() {
      await hub.close();
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await redis.quit();
      await pool.end();
    },
  };
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;
