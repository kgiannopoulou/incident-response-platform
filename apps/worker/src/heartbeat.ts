import os from "node:os";
import type { Redis } from "ioredis";
import { WORKER_HEARTBEAT_PREFIX, WORKER_HEARTBEAT_TTL_SECONDS, type WorkerHeartbeat } from "@irp/shared";

// Each worker process keeps a key `irp:worker:<host>:<pid>` alive with a
// short TTL and a few counters. A crashed worker simply stops refreshing it
// and disappears from /health and the System page within 30 s.
export class Heartbeat {
  readonly stats: WorkerHeartbeat;
  private timer: NodeJS.Timeout | null = null;

  constructor(private redis: Redis) {
    const now = new Date().toISOString();
    this.stats = { id: `${os.hostname()}:${process.pid}`, startedAt: now, lastSeenAt: now, processed: 0, failed: 0, deadLettered: 0 };
  }

  private get key() {
    return `${WORKER_HEARTBEAT_PREFIX}${this.stats.id}`;
  }

  async beat() {
    this.stats.lastSeenAt = new Date().toISOString();
    await this.redis.set(this.key, JSON.stringify(this.stats), "EX", WORKER_HEARTBEAT_TTL_SECONDS);
  }

  start(intervalMs = 10_000) {
    const tick = () => this.beat().catch((err) => console.error("[heartbeat] failed:", err.message));
    void tick();
    this.timer = setInterval(tick, intervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.redis.del(this.key).catch(() => {});
  }
}
