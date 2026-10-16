import { createHash } from "node:crypto";
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

// Password guessing on /auth/login (Phase 24). Failed logins are counted per
// account (any IP) and per IP (any account) in a fixed 15-minute window:
//   10 failures for one email   -> that account is locked for the window
//   30 failures from one IP     -> that IP is locked for the window
// A locked request gets 429 *before* the password is checked, so the lock
// can't be used to confirm a correct guess. A successful login clears the
// account's counter. Emails are hashed in the key (no addresses in Redis).
// Fails open like the other limits: a Redis outage must not lock responders
// out during an incident.
export const LOGIN_LIMITS = { perAccount: 10, perIp: 30, windowSeconds: 15 * 60 };

export class LoginThrottle {
  constructor(
    private redis: Redis,
    private limits = LOGIN_LIMITS,
    private prefix = "irp:login"
  ) {
    trackRedis(redis);
  }

  private keys(ip: string, email: string) {
    const account = createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
    return { account: `${this.prefix}:account:${account}`, ip: `${this.prefix}:ip:${ip}` };
  }

  // Seconds until the caller may try again, or 0 when not locked.
  async lockedFor(ip: string, email: string): Promise<number> {
    try {
      if (redisIsDown(this.redis)) throw new Error("Redis connection lost");
      const k = this.keys(ip, email);
      const results = (await withTimeout(
        this.redis.multi().get(k.account).get(k.ip).ttl(k.account).ttl(k.ip).exec(),
        REDIS_DEADLINE_MS,
        "login throttle"
      )) as [Error | null, unknown][];
      const [account, byIp, ttlAccount, ttlIp] = results.map(([, value]) => Number(value));
      if (account >= this.limits.perAccount) return Math.max(1, ttlAccount);
      if (byIp >= this.limits.perIp) return Math.max(1, ttlIp);
      return 0;
    } catch (err) {
      logDegraded("login throttle unavailable, allowing logins", err);
      return 0;
    }
  }

  async recordFailure(ip: string, email: string) {
    try {
      if (redisIsDown(this.redis)) throw new Error("Redis connection lost");
      const k = this.keys(ip, email);
      const w = this.limits.windowSeconds;
      await withTimeout(
        this.redis.multi().incr(k.account).expire(k.account, w, "NX").incr(k.ip).expire(k.ip, w, "NX").exec(),
        REDIS_DEADLINE_MS,
        "login throttle"
      );
    } catch (err) {
      logDegraded("failed to record login failure", err);
    }
  }

  async recordSuccess(ip: string, email: string) {
    try {
      if (redisIsDown(this.redis)) return;
      await withTimeout(this.redis.del(this.keys(ip, email).account), REDIS_DEADLINE_MS, "login throttle");
    } catch {
      // best effort
    }
  }
}
