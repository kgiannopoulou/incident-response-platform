import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IncidentClient } from "@incident-platform/sdk";
import { createPool, isDatabaseUnavailable } from "@irp/database";
import { TEST_KEYS, testDatabaseUrl } from "@irp/database/testing";
import { QUEUES } from "@irp/shared";
import { createApp } from "../src/app";
import type { Deps } from "../src/deps";
import { RateLimiter } from "../src/lib/rate-limit";
import { RealtimeHub } from "../src/lib/realtime";
import { closeRedis } from "../src/lib/resilience";
import { createTestContext, type TestContext } from "./helpers";

// Phase 21: what happens when things break. Each block answers one of the
// plan's questions against the real app; docs/failure-handling.md has the
// full table.

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const critical = { severity: "critical", title: "Checkout error rate exceeded threshold", deduplicationKey: "checkout-errors" };

// Nothing listens on these ports: a Redis / Postgres that is down.
const DEAD_REDIS = "redis://127.0.0.1:6399";
const DEAD_POSTGRES = "postgres://incidents:incidents@127.0.0.1:1/incidents";

function deadRedis() {
  const redis = new Redis(DEAD_REDIS, { maxRetriesPerRequest: null, retryStrategy: () => 200 });
  redis.on("error", () => {});
  return redis;
}

// The app with Redis unreachable (Postgres fine): same options as production
// (offline queue on, maxRetriesPerRequest null), so commands would wait forever.
function appWithoutRedis() {
  const redis = deadRedis();
  const connection = { url: DEAD_REDIS, retryStrategy: () => 200 };
  const queues = Object.fromEntries(
    (["notifications", "escalations", "webhooks", "deadLetter", "aiDrafts"] as const).map((name) => {
      const q = new Queue(QUEUES[name], { connection });
      q.on("error", () => {});
      return [name, q];
    })
  ) as unknown as Deps["queues"];
  const subscriber = deadRedis();
  const reader = deadRedis();
  const hub = new RealtimeHub(subscriber, reader);
  const deps: Deps = {
    ...t.deps,
    redis,
    queues,
    hub,
    rateLimiter: new RateLimiter(redis, { authFailuresPerMinute: 20 }),
  };
  return {
    app: createApp(deps),
    async close() {
      await hub.close();
      await closeRedis(redis);
      // Queue.close() would wait for a connection that never comes.
      for (const q of Object.values(queues)) void q.disconnect().catch(() => {});
    },
  };
}

describe("What if Redis goes down?", () => {
  let broken: ReturnType<typeof appWithoutRedis>;
  beforeAll(async () => {
    broken = appWithoutRedis();
    await new Promise((r) => setTimeout(r, 300)); // first connection attempt fails
  });
  afterAll(() => broken.close());

  it("still accepts alerts and opens incidents quickly; the sweeper pages once Redis is back", async () => {
    const started = Date.now();
    const res = await request(broken.app).post("/api/v1/alerts").set("Authorization", `Bearer ${TEST_KEYS.checkout}`).send(critical);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ decision: "incident_created", incident: { number: 1, severity: "sev1" } });
    // Once ioredis knows the connection is gone, Redis work is skipped at once.
    expect(elapsed).toBeLessThan(1_500);

    // The paging job never reached Redis, but Postgres says step 1 is due:
    // this is exactly what the worker's sweeper looks for.
    const { rows } = await t.deps.pool.query(`SELECT next_escalation_at <= now() AS due, escalation_level FROM incidents`);
    expect(rows).toEqual([{ due: true, escalation_level: 0 }]);
  });

  it("lets responders keep working the incident", async () => {
    await t.alert(TEST_KEYS.checkout, critical).expect(202);
    const res = await request(broken.app).post("/api/v1/incidents/1/acknowledge").set(await t.as("sam"));
    expect(res.status).toBe(200);
    expect(res.body.incident.status).toBe("acknowledged");
  });

  it("reports itself degraded, not down, within the health check's deadlines", async () => {
    const started = Date.now();
    const res = await request(broken.app).get("/health");
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, status: "degraded", acceptingAlerts: true, postgres: "up", redis: "down" });
  });

  it("answers 503 on the System page instead of hanging", async () => {
    const res = await request(broken.app).get("/api/v1/admin/queues").set(await t.as("alex"));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Redis is unavailable/);
  });
});

describe("What if PostgreSQL goes down?", () => {
  let app: ReturnType<typeof createApp>;
  let deadPool: pg.Pool;
  beforeAll(() => {
    deadPool = createPool(DEAD_POSTGRES);
    app = createApp({ ...t.deps, pool: deadPool });
  });
  afterAll(() => deadPool.end());

  it("answers alerts with 503 + Retry-After, so senders retry instead of dropping them", async () => {
    const res = await request(app).post("/api/v1/alerts").set("Authorization", `Bearer ${TEST_KEYS.checkout}`).send(critical);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body).toEqual({ error: "Database unavailable; retry shortly", retryable: true });
  });

  it("fails readiness but not liveness (restarting the API wouldn't help)", async () => {
    const ready = await request(app).get("/health");
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: "unavailable", acceptingAlerts: false, postgres: "down" });
    await request(app).get("/health/live").expect(200, { ok: true });
  });

  it("survives Postgres killing its connections (restart / failover) and serves the next request", async () => {
    const pool = createPool(testDatabaseUrl(), { max: 3, application_name: "irp-failover-test" });
    const live = createApp({ ...t.deps, pool });
    try {
      await request(live).get("/health").expect(200);
      // Terminate every backend this pool holds, as a server restart would.
      // Without the pool's 'error' listener this crashes the test process.
      const admin = new pg.Client({ connectionString: testDatabaseUrl() });
      await admin.connect();
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = 'irp-failover-test'`
      );
      await admin.end();
      await new Promise((r) => setTimeout(r, 100));

      const res = await request(live).post("/api/v1/alerts").set("Authorization", `Bearer ${TEST_KEYS.checkout}`).send(critical);
      expect(res.status).toBe(202);
    } finally {
      await pool.end();
    }
  });

  it("classifies connection failures as 'unavailable' and query errors as not", async () => {
    const pool = createPool(DEAD_POSTGRES, { connectionTimeoutMillis: 1_000 });
    const err = await pool.query("SELECT 1").catch((e: unknown) => e);
    await pool.end();
    expect(isDatabaseUnavailable(err)).toBe(true);
    expect(isDatabaseUnavailable(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isDatabaseUnavailable({ code: "57P01" })).toBe(true);
    const syntax = await t.deps.pool.query("SELEC 1").catch((e: unknown) => e);
    expect(isDatabaseUnavailable(syntax)).toBe(false);
    expect(isDatabaseUnavailable({ code: "23505" })).toBe(false);
  });
});

describe("What if the same webhook (alert) arrives twice?", () => {
  const send = (key: string | null, body: object = critical, apiKey = TEST_KEYS.checkout) => {
    const req = request(t.app).post("/api/v1/alerts").set("Authorization", `Bearer ${apiKey}`);
    if (key) req.set("Idempotency-Key", key);
    return req.send(body);
  };
  const count = async (table: string) => (await t.deps.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

  it("records it once and replays the first response for the repeat", async () => {
    const first = await send("prom-evt-8812").expect(202);
    const again = await send("prom-evt-8812").expect(202);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(await count("alerts")).toBe(1);
    const { rows } = await t.deps.pool.query(`SELECT alert_count FROM incidents`);
    expect(rows).toEqual([{ alert_count: 1 }]);
  });

  it("records it once when 10 copies arrive at the same moment", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => send("burst-1")));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(202));
    expect(results.filter((r) => r.body.replayed).length).toBe(9);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await count("alerts")).toBe(1);
  });

  it("without a key, repeats are separate alerts grouped into the open incident (as before)", async () => {
    await send(null).expect(202);
    const second = await send(null).expect(202);
    expect(second.body).toMatchObject({ decision: "grouped", incident: { alertCount: 2 } });
  });

  it("refuses a key reused with a different body (422) and malformed keys (400)", async () => {
    await send("evt-1").expect(202);
    const res = await send("evt-1", { ...critical, title: "Something else" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/different request body/);
    await send("has spaces in it").expect(400);
    await send("x".repeat(256)).expect(400);
    expect(await count("alerts")).toBe(1);
  });

  it("scopes keys per service, and forgets them after 24 hours", async () => {
    await send("evt-7").expect(202);
    const other = await send("evt-7", { ...critical, service: undefined }, TEST_KEYS.auth).expect(202);
    expect(other.body.replayed).toBeUndefined();
    await t.deps.pool.query(`UPDATE alert_idempotency_keys SET created_at = now() - interval '25 hours'`);
    const later = await send("evt-7").expect(202);
    expect(later.body).toMatchObject({ decision: "grouped" });
    expect(await count("alerts")).toBe(3);
  });

  it("doesn't store a key when the request failed, so the retry is processed", async () => {
    await send("evt-9", { severity: "critical" }).expect(400); // invalid: no title
    await send("evt-9").expect(202);
    expect(await count("alerts")).toBe(1);
  });
});

describe("What if the response to a sender is lost? (SDK retries)", () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(() => {
    server = t.app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("the SDK's retry after a dropped response replays instead of recording the alert twice", async () => {
    let calls = 0;
    const keys: (string | null)[] = [];
    // The first attempt reaches the API and is committed, then the
    // connection "drops" before the client sees the answer.
    const flaky: typeof fetch = async (input, init) => {
      calls++;
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      const res = await fetch(input, init);
      if (calls === 1) throw new TypeError("fetch failed (socket hang up)");
      return res;
    };
    const incidents = new IncidentClient({ apiKey: TEST_KEYS.checkout, baseUrl, baseDelayMs: 1, fetch: flaky });
    const result = await incidents.alert({ severity: "critical", title: "Database connection failure", deduplicationKey: "db" });

    expect(calls).toBe(2);
    expect(keys[0]).toMatch(/^sdk-[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(result).toMatchObject({ decision: "incident_created", replayed: true });
    const { rows } = await t.deps.pool.query(`SELECT count(*)::int AS n FROM alerts`);
    expect(rows[0].n).toBe(1);
  });
});
