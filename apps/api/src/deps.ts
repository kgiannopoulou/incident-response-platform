import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { RateLimiter } from "./lib/rate-limit";
import type { RealtimeHub } from "./lib/realtime";

// Everything the app needs from the outside world, passed in explicitly so
// the integration tests can build the app against a test database.
export type Deps = {
  pool: Pool;
  redis: Redis; // publisher connection
  queues: { notifications: Queue; escalations: Queue };
  hub: RealtimeHub;
  rateLimiter: RateLimiter;
  jwtSecret: string;
  webOrigin: string;
  secureCookies: boolean;
  // Express "trust proxy" setting, so req.ip (used for auth-failure rate
  // limiting) is the real client behind a load balancer. Off by default.
  trustProxy?: boolean | number | string;
};
