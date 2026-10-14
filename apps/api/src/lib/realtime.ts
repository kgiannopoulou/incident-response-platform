import type { Response } from "express";
import type { Redis } from "ioredis";
import { orgStream, type StreamControlEvent } from "@irp/shared";
import { compareStreamIds, parseRealtimeMessage } from "@irp/shared/realtime";

// Fans Redis pub/sub messages out to browsers connected over Server-Sent
// Events. One Redis subscription per API process (pattern on every
// organization's channel); each message is written only to the SSE clients
// of the organization it belongs to. Because the API and worker publish via
// Redis, an event raised by any process reaches every connected browser.
//
// Every event has an id (its Redis Stream id). A browser that reconnects
// sends the last id it saw (Last-Event-ID); the hub replays everything after
// it from the stream before switching the connection to live messages, so a
// dropped connection or an API restart doesn't leave a dashboard stale.

type Client = {
  res: Response;
  // While replaying, live messages are held back and flushed afterwards
  // (minus anything the replay already covered), so nothing is lost or
  // reordered in the gap between "read the stream" and "go live".
  pending: { id: string; json: string }[] | null;
};

export class RealtimeHub {
  private clients = new Map<number, Set<Client>>();
  private heartbeat: NodeJS.Timeout;

  constructor(
    private subscriber: Redis,
    private reader: Redis // a normal connection: a subscribed one can't run XRANGE
  ) {
    subscriber.psubscribe("irp:events:org:*").catch((err) => console.error("SSE subscribe failed:", err));
    subscriber.on("pmessage", (_pattern, channel, message) => {
      const organizationId = Number(channel.split(":").pop());
      const event = parseRealtimeMessage(message);
      for (const client of this.clients.get(organizationId) ?? []) {
        if (client.pending) client.pending.push(event);
        else writeEvent(client.res, event.id, event.json);
      }
    });
    // Comment lines keep proxies from closing idle connections.
    this.heartbeat = setInterval(() => {
      for (const set of this.clients.values()) for (const client of set) client.res.write(": ping\n\n");
    }, 25_000);
    this.heartbeat.unref();
  }

  async add(organizationId: number, res: Response, lastEventId: string | null) {
    const client: Client = { res, pending: lastEventId ? [] : null };
    const set = this.clients.get(organizationId) ?? new Set();
    set.add(client);
    this.clients.set(organizationId, set);
    res.on("close", () => set.delete(client));
    if (!lastEventId) return;

    let replayedUpTo = lastEventId;
    try {
      const stream = orgStream(organizationId);
      // Only replay from an id we still have; otherwise the gap can't be
      // filled and the client must re-fetch everything.
      const anchor = await this.reader.xrange(stream, lastEventId, lastEventId);
      if (anchor.length === 0) {
        writeControl(res, { type: "resync" });
      } else {
        const missed = await this.reader.xrange(stream, `(${lastEventId}`, "+");
        for (const [id, fields] of missed) {
          writeEvent(res, id, fields[1]);
          replayedUpTo = id;
        }
      }
    } catch (err) {
      console.error("SSE replay failed:", err);
      writeControl(res, { type: "resync" });
    } finally {
      for (const event of client.pending ?? []) {
        if (compareStreamIds(event.id, replayedUpTo) > 0) writeEvent(res, event.id, event.json);
      }
      client.pending = null;
    }
  }

  get connectionCount() {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }

  async close() {
    clearInterval(this.heartbeat);
    for (const set of this.clients.values()) for (const client of set) client.res.end();
    await this.subscriber.quit();
    await this.reader.quit();
  }
}

function writeEvent(res: Response, id: string, json: string) {
  res.write(`id: ${id}\ndata: ${json}\n\n`);
}

function writeControl(res: Response, event: StreamControlEvent) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
