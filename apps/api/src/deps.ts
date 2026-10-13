import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { RealtimeHub } from "./lib/realtime";

// Everything the app needs from the outside world, passed in explicitly so
// the integration tests can build the app against a test database.
export type Deps = {
  pool: Pool;
  redis: Redis; // publisher connection
  queues: { notifications: Queue; escalations: Queue };
  hub: RealtimeHub;
  jwtSecret: string;
  webOrigin: string;
  secureCookies: boolean;
};
