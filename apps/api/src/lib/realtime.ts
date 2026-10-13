import type { Response } from "express";
import type { Redis } from "ioredis";

// Fans Redis pub/sub messages out to browsers connected over Server-Sent
// Events. One Redis subscription per API process (pattern on every
// organization's channel); each message is written only to the SSE clients
// of the organization it belongs to. Because the API and worker publish via
// Redis, an event raised by any process reaches every connected browser.
export class RealtimeHub {
  private clients = new Map<number, Set<Response>>();
  private heartbeat: NodeJS.Timeout;

  constructor(private subscriber: Redis) {
    subscriber.psubscribe("irp:events:org:*").catch((err) => console.error("SSE subscribe failed:", err));
    subscriber.on("pmessage", (_pattern, channel, message) => {
      const organizationId = Number(channel.split(":").pop());
      for (const res of this.clients.get(organizationId) ?? []) {
        res.write(`data: ${message}\n\n`);
      }
    });
    // Comment lines keep proxies from closing idle connections.
    this.heartbeat = setInterval(() => {
      for (const set of this.clients.values()) for (const res of set) res.write(": ping\n\n");
    }, 25_000);
    this.heartbeat.unref();
  }

  add(organizationId: number, res: Response) {
    const set = this.clients.get(organizationId) ?? new Set();
    set.add(res);
    this.clients.set(organizationId, set);
    res.on("close", () => set.delete(res));
  }

  get connectionCount() {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }

  async close() {
    clearInterval(this.heartbeat);
    for (const set of this.clients.values()) for (const res of set) res.end();
    await this.subscriber.quit();
  }
}
