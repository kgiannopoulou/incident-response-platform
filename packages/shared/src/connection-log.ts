// Server-only helper ("@irp/shared/connection-log"): one log line when a
// Redis connection is lost and one when it's back, instead of a stack trace
// per reconnect attempt. Also installs the 'error' listener that ioredis and
// BullMQ need — without one, every failed reconnect prints "Unhandled error
// event". Works for ioredis clients, BullMQ queues and workers (anything that
// emits 'error'; 'reconnecting' / 'ready' are used when available).

type Emitter = { on(event: string, listener: (...args: never[]) => void): unknown };

export function logConnection(name: string, conn: Emitter, whileDown = "") {
  let down = false;
  const lost = (reason: string) => {
    if (down) return;
    down = true;
    console.error(`[${name}] connection lost (${reason}); reconnecting${whileDown ? ` — ${whileDown}` : ""}`);
  };
  conn.on("error", (err: Error & { code?: string; errors?: { code?: string }[] }) => {
    lost(err.code ?? err.errors?.[0]?.code ?? (err.message || "error"));
  });
  conn.on("reconnecting", () => lost("disconnected"));
  conn.on("ready", () => {
    if (!down) return;
    down = false;
    console.log(`[${name}] connection restored`);
  });
}
