import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
import { orgStream } from "@irp/shared";
import { createTestContext, type TestContext } from "./helpers";

let t: TestContext;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  t = await createTestContext();
  server = t.app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await t.close();
});
beforeEach(() => t.reset());

type Event = { type: string; id?: string; number?: number; status?: string; severity?: string; actor?: string };

// Minimal SSE client: next(predicate) resolves with the first matching
// `data:` message (or null after `timeoutMs`). The message's `id:` line, if
// any, is exposed as `event.id`.
function sseReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const queue: Event[] = [];
  let buffer = "";
  let inFlight: Promise<void> | null = null;

  async function pull() {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const lines = buffer.slice(0, index).split("\n");
      buffer = buffer.slice(index + 2);
      const data = lines.find((l) => l.startsWith("data: "));
      const id = lines.find((l) => l.startsWith("id: "));
      if (data) queue.push({ ...JSON.parse(data.slice(6)), ...(id ? { id: id.slice(4) } : {}) });
    }
  }

  return {
    async next(predicate: (e: Event) => boolean, timeoutMs = 3000): Promise<Event | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = queue.findIndex(predicate);
        if (i >= 0) return queue.splice(i, 1)[0];
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        // Never run two reads at once: a read left over from a timed-out
        // wait is awaited again instead.
        inFlight ??= pull().finally(() => (inFlight = null));
        const timedOut = await Promise.race([
          inFlight.then(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(true), remaining)),
        ]);
        if (timedOut) return null;
      }
    },
    // Everything received within `ms`.
    async drain(ms = 300) {
      while ((await this.next(() => false, ms)) !== null);
      return queue.splice(0);
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

async function connect(name: "alex" | "sam" | "jordan" | "eve", lastEventId?: string) {
  const headers: Record<string, string> = await t.as(name);
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  const res = await fetch(`${baseUrl}/api/v1/stream`, { headers });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const sse = sseReader(res.body!);
  expect(await sse.next((e) => e.type === "connected")).toBeTruthy();
  return sse;
}

const critical = { title: "Checkout down", severity: "critical", source: "probe" };

describe("GET /api/v1/stream (SSE)", () => {
  it("rejects anonymous connections", async () => {
    expect((await fetch(`${baseUrl}/api/v1/stream`)).status).toBe(401);
  });

  it("pushes incident events to that organization's browsers only", async () => {
    const acme = await connect("alex");
    const other = await connect("eve");

    await t.alert(TEST_KEYS.checkout, critical);

    expect(await acme.next((e) => e.type === "incident.created")).toMatchObject({ number: 1, status: "triggered", severity: "sev1" });
    expect(await acme.next((e) => e.type === "service.updated")).toBeTruthy();
    // The other organization hears nothing about Acme's incident.
    expect(await other.next(() => true, 500)).toBeNull();

    await acme.close();
    await other.close();
  });

  it("two browsers on one incident: A acknowledges, B sees ACKNOWLEDGED immediately", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    const browserA = await t.as("sam");
    const browserB = await connect("alex");

    await request(t.app).post("/api/v1/incidents/1/acknowledge").set(browserA).expect(200);

    const update = await browserB.next((e) => e.type === "incident.updated" && e.status === "acknowledged");
    expect(update).toMatchObject({ number: 1, status: "acknowledged", actor: "Sam" });
    expect(update!.id).toMatch(/^\d+-\d+$/);
    expect(await browserB.next((e) => e.type === "timeline.added")).toBeTruthy();
    await browserB.close();
  });

  it("gives every event an increasing id", async () => {
    const sse = await connect("alex");
    await t.alert(TEST_KEYS.checkout, critical);
    await t.alert(TEST_KEYS.auth, critical);
    const events = (await sse.drain()).filter((e) => e.id);
    expect(events.length).toBeGreaterThan(3);
    const ids = events.map((e) => e.id!);
    expect([...ids].sort(compare)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    await sse.close();
  });

  it("replays what a browser missed while disconnected (Last-Event-ID)", async () => {
    const first = await connect("alex");
    await t.alert(TEST_KEYS.checkout, critical);
    const created = await first.next((e) => e.type === "incident.created");
    const seen = (await first.drain()).filter((e) => e.id).pop() ?? created!;
    await first.close();

    // While the browser is away, Sam acknowledges and resolves.
    const sam = await t.as("sam");
    await request(t.app).post("/api/v1/incidents/1/acknowledge").set(sam).expect(200);
    await request(t.app).post("/api/v1/incidents/1/status").set(sam).send({ status: "resolved" }).expect(200);

    const back = await connect("alex", seen.id);
    const replayed = await back.drain();
    const statuses = replayed.filter((e) => e.type === "incident.updated" && e.status).map((e) => e.status);
    expect(statuses).toContain("acknowledged");
    expect(statuses.at(-1)).toBe("resolved");
    // Nothing from before the reconnect point is sent again.
    expect(replayed.find((e) => e.type === "incident.created")).toBeUndefined();
    expect(replayed.every((e) => compare(e.id!, seen.id!) > 0)).toBe(true);

    // ...and the connection carries on live afterwards.
    await t.alert(TEST_KEYS.auth, critical);
    expect(await back.next((e) => e.type === "incident.created")).toMatchObject({ number: 2 });
    await back.close();
  });

  it("tells a browser to resync when it can't replay from its id", async () => {
    const sse = await connect("alex", "1-0"); // an id the stream no longer has
    expect(await sse.next((e) => e.type === "resync")).toBeTruthy();
    await t.alert(TEST_KEYS.checkout, critical);
    expect(await sse.next((e) => e.type === "incident.created")).toBeTruthy();
    await sse.close();
  });

  it("ignores malformed Last-Event-ID values", async () => {
    const sse = await connect("alex", "not-an-id");
    expect(await sse.next((e) => e.type === "resync", 300)).toBeNull();
    await sse.close();
  });

  it("keeps a bounded, per-organization event history in Redis", async () => {
    await t.alert(TEST_KEYS.checkout, critical);
    await t.alert(TEST_KEYS.other, critical);
    const acme = await t.deps.redis.xrange(orgStream(t.fx.orgs.acme), "-", "+");
    const other = await t.deps.redis.xrange(orgStream(t.fx.orgs.other), "-", "+");
    expect(acme.length).toBeGreaterThan(0);
    expect(other.length).toBeGreaterThan(0);
    expect(acme.some(([, fields]) => fields[1].includes('"incident.created"'))).toBe(true);
  });
});

function compare(a: string, b: string) {
  const [am, as] = a.split("-").map(Number);
  const [bm, bs] = b.split("-").map(Number);
  return am - bm || as - bs;
}
