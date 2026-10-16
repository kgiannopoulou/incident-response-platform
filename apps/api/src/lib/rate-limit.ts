import type { Redis } from "ioredis";
import { logDegraded, REDIS_DEADLINE_MS, redisIsDown, trackRedis, withTimeout } from "./resilience";

// Rate limiting for alert ingestion, kept in Redis so every API instance
// shares the same counters.
//
// 1. Per API key: a token bucket. Capacity = the key's requests-per-minute,
//    refilled continuously, so a sender can burst up to its limit and then
//    sustain limit/60 requests per second. Implemented as one Lua script so
//    read-refill-take is atomic, using Redis' own clock (TIME) so API
//    instances with skewed clocks agree.
//
// 2. Per client IP, for *failed* authentications: after too many bad keys in
//    a minute the IP gets 429 before its key is even looked up — this keeps
//    key guessing and accidental retry storms with a wrong key cheap.
//
// Both fail open: if Redis is unreachable (or slower than REDIS_DEADLINE_MS)
// the request is let through and the error logged. Losing alerts during an outage is worse than briefly losing
// rate limiting.

const TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = capacity / 60000
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill_per_ms)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', key, 60000 + 1000)

local retry_after_ms = 0
if allowed == 0 then retry_after_ms = math.ceil((1 - tokens) / refill_per_ms) end
local full_in_ms = math.ceil((capacity - tokens) / refill_per_ms)
return { allowed, math.floor(tokens), retry_after_ms, full_in_ms }
`;

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number; // 0 when allowed
  resetSeconds: number; // until the bucket is full again
};

export class RateLimiter {
  constructor(
    private redis: Redis,
    private options: { authFailuresPerMinute: number; prefix?: string } = { authFailuresPerMinute: 20 }
  ) {
    trackRedis(redis);
  }

  private get prefix() {
    return this.options.prefix ?? "irp:ratelimit";
  }

  async consumeKey(keyId: number, perMinute: number): Promise<RateLimitResult> {
    try {
      if (redisIsDown(this.redis)) throw new Error("Redis connection lost");
      const [allowed, remaining, retryAfterMs, fullInMs] = (await withTimeout(
        this.redis.eval(TOKEN_BUCKET, 1, `${this.prefix}:key:${keyId}`, perMinute),
        REDIS_DEADLINE_MS,
        "rate limiter"
      )) as number[];
      return {
        allowed: allowed === 1,
        limit: perMinute,
        remaining,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        resetSeconds: Math.ceil(fullInMs / 1000),
      };
    } catch (err) {
      logDegraded("rate limiter unavailable, allowing requests", err);
      return { allowed: true, limit: perMinute, remaining: perMinute, retryAfterSeconds: 0, resetSeconds: 0 };
    }
  }

  // Fixed one-minute window of failed authentications per IP.
  async isBlocked(ip: string) {
    try {
      if (redisIsDown(this.redis)) throw new Error("Redis connection lost");
      const count = Number(await withTimeout(this.redis.get(`${this.prefix}:authfail:${ip}`), REDIS_DEADLINE_MS, "auth-failure check"));
      return count >= this.options.authFailuresPerMinute;
    } catch (err) {
      logDegraded("auth-failure lock-out unavailable", err);
      return false;
    }
  }

  async recordAuthFailure(ip: string) {
    const key = `${this.prefix}:authfail:${ip}`;
    try {
      if (redisIsDown(this.redis)) throw new Error("Redis connection lost");
      await withTimeout(this.redis.multi().incr(key).expire(key, 60, "NX").exec(), REDIS_DEADLINE_MS, "auth-failure record");
    } catch (err) {
      logDegraded("failed to record auth failure", err);
    }
  }
}
