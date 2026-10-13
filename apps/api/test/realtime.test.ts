import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_KEYS } from "@irp/database/testing";
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

type Event = { type: string; number?: number };

// Minimal SSE client: next(predicate) resolves with the first matching
// `data:` message (or null after `timeoutMs`).
function sseReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const queue: Event[] = [];
  let buffer = "";

  async function pull() {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer
        .slice(0, index)
        .split("\n")
        .find((l) => l.startsWith("data: "));
      buffer = buffer.slice(index + 2);
      if (line) queue.push(JSON.parse(line.slice(6)));
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
        const timedOut = await Promise.race([
          pull().then(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(true), remaining)),
        ]);
        if (timedOut) return null;
      }
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

describe("GET /api/v1/stream (SSE)", () => {
  it("rejects anonymous connections", async () => {
    expect((await fetch(`${baseUrl}/api/v1/stream`)).status).toBe(401);
  });

  it("pushes incident events to that organization's browsers only", async () => {
    const acmeRes = await fetch(`${baseUrl}/api/v1/stream`, { headers: await t.as("alex") });
    const otherRes = await fetch(`${baseUrl}/api/v1/stream`, { headers: await t.as("eve") });
    expect(acmeRes.headers.get("content-type")).toBe("text/event-stream");
    const acme = sseReader(acmeRes.body!);
    const other = sseReader(otherRes.body!);
    expect(await acme.next((e) => e.type === "connected")).toBeTruthy();
    expect(await other.next((e) => e.type === "connected")).toBeTruthy();

    await t.alert(TEST_KEYS.checkout, { title: "Checkout down", severity: "critical", source: "probe" });

    expect(await acme.next((e) => e.type === "incident.created")).toMatchObject({ number: 1 });
    expect(await acme.next((e) => e.type === "service.updated")).toBeTruthy();
    // The other organization hears nothing about Acme's incident.
    expect(await other.next(() => true, 500)).toBeNull();

    await acme.close();
    await other.close();
  });
});
