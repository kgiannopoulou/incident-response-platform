import { orgChannel, orgStream, type RealtimeEvent } from "./events";

// Server-only (Redis) side of live updates: `@irp/shared/realtime`, used by
// both the API and the worker so every event takes the same path.
//
// Each event is appended to the organization's Redis Stream *and* published
// on its pub/sub channel, atomically, in one Lua script:
//
//   XADD irp:stream:org:<id> MAXLEN ~ 1000 * e <json>   -> "1760429748123-0"
//   PUBLISH irp:events:org:<id> "1760429748123-0 <json>"
//
// - Pub/sub delivers it to every API process right away (low latency).
// - The stream id becomes the SSE event id, and the stream keeps the last
//   ~1000 events, so a browser that reconnects with Last-Event-ID gets what
//   it missed instead of silently going stale.
// - Doing both in one script means pub/sub order always matches stream
//   order, even with several API processes and workers publishing at once.

export const STREAM_MAX_LENGTH = 1000;

const PUBLISH_SCRIPT = `
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], '*', 'e', ARGV[1])
redis.call('PUBLISH', KEYS[2], id .. ' ' .. ARGV[1])
return id
`;

// The subset of ioredis this needs, so @irp/shared doesn't depend on it.
export type RedisEval = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export async function publishRealtime(redis: RedisEval, organizationId: number, event: RealtimeEvent) {
  return (await redis.eval(
    PUBLISH_SCRIPT,
    2,
    orgStream(organizationId),
    orgChannel(organizationId),
    JSON.stringify(event),
    STREAM_MAX_LENGTH
  )) as string;
}

// Pub/sub messages are "<stream id> <json>".
export function parseRealtimeMessage(message: string) {
  const space = message.indexOf(" ");
  return { id: message.slice(0, space), json: message.slice(space + 1) };
}

// Stream ids are "<ms>-<seq>"; compares them numerically.
export function compareStreamIds(a: string, b: string) {
  const [am, as] = a.split("-").map(BigInt);
  const [bm, bs] = b.split("-").map(BigInt);
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}

export const isStreamId = (value: unknown): value is string => typeof value === "string" && /^\d+-\d+$/.test(value);
