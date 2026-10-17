#!/usr/bin/env node
// Alert-ingestion load test against a running stack (`docker compose up` or
// the dev servers). Zero dependencies (Node 20+ fetch).
//
//   npm run loadtest -- --alerts 2000 --concurrency 50 --problems 20
//
// What it does:
//   1. logs in as the seeded admin and creates a throwaway service with its
//      own API key (high per-key limit, no escalation policy: nobody is paged)
//   2. fires --alerts critical alerts with --concurrency requests in flight,
//      spread over --problems deduplication keys (a storm of repeats)
//   3. reports client-side throughput and latency percentiles, next to what
//      the API measured itself (GET /admin/ingestion)
//   4. checks the invariants: exactly --problems incidents, every accepted
//      alert attached to one of them, no 5xx
//   5. resolves the incidents again (action: "resolve" + auto-resolve)
//
// The API's flood guard allows 1,200 requests per credential per minute by
// default; start the API with FLOOD_GUARD_PER_MINUTE=1000000 to measure
// ingestion rather than the guard (429s are counted and reported).
//
//   API_URL (default http://localhost:4000)
//   ADMIN_EMAIL / ADMIN_PASSWORD (default the seeded alex@acme.test / password123)

const API = (process.env.API_URL ?? "http://localhost:4000") + "/api/v1";
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith("--") ? [[arg.slice(2), all[i + 1]]] : []))
);
const ALERTS = Number(args.alerts ?? 2000);
const CONCURRENCY = Number(args.concurrency ?? 50);
const PROBLEMS = Number(args.problems ?? 20);
const JSON_OUT = "json" in args;
// The invariant check reads the incident list, which returns at most 200.
if (PROBLEMS > 200) throw new Error("--problems can be at most 200");

async function call(path, { token, method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

const log = (...a) => !JSON_OUT && console.log(...a);

const { token } = await call("/auth/login", {
  method: "POST",
  body: { email: process.env.ADMIN_EMAIL ?? "alex@acme.test", password: process.env.ADMIN_PASSWORD ?? "password123" },
});
const stamp = Date.now().toString(36);
const created = await call("/services", { token, method: "POST", body: { name: `Load test ${stamp}`, autoResolve: true, description: "Created by scripts/load-test.mjs" } });
const service = created.service ?? created;
const { apiKey } = await call(`/services/${service.id}/keys`, { token, method: "POST", body: { name: "load test", rateLimitPerMinute: 100_000 } });
const key = apiKey.key ?? apiKey.secret ?? apiKey.token;
log(`service ${service.slug} (#${service.id}), ${ALERTS} alerts, ${CONCURRENCY} in flight, ${PROBLEMS} problems`);

const latencies = [];
const statuses = {};
const decisions = {};
let next = 0;
async function sender() {
  while (next < ALERTS) {
    const i = next++;
    const problem = i % PROBLEMS;
    const started = performance.now();
    const res = await fetch(`${API}/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        title: `Load test problem ${problem}`,
        severity: "critical",
        source: "load-test",
        deduplicationKey: `load-${stamp}-${problem}`,
        metadata: { n: i },
      }),
    });
    const body = await res.json().catch(() => ({}));
    latencies.push(performance.now() - started);
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    if (body.decision) decisions[body.decision] = (decisions[body.decision] ?? 0) + 1;
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, sender));
const seconds = (performance.now() - t0) / 1000;
latencies.sort((a, b) => a - b);
// The API's own measurement over (about) this run; leave 10 s between runs
// so the window doesn't include the previous one.
const server = await call(`/admin/ingestion?window=${Math.max(10, Math.ceil(seconds) + 1)}`, { token });

const incidents = (await call(`/incidents?status=all&serviceId=${service.id}`, { token })).incidents;
const accepted = statuses[202] ?? 0;
const attached = incidents.reduce((sum, i) => sum + Number(i.alert_count ?? i.alertCount ?? 0), 0);
const fiveXX = Object.entries(statuses).filter(([s]) => Number(s) >= 500).reduce((n, [, c]) => n + c, 0);
const checks = {
  [`one incident per problem (${incidents.length}/${PROBLEMS})`]: incidents.length === Math.min(PROBLEMS, accepted ? PROBLEMS : 0),
  [`every accepted alert attached (${attached}/${accepted})`]: attached === accepted,
  [`no 5xx (${fiveXX})`]: fiveXX === 0,
};

// Clean up: resolve every problem; auto-resolve closes the incidents.
for (let p = 0; p < PROBLEMS; p++) {
  await fetch(`${API}/alerts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ action: "resolve", deduplicationKey: `load-${stamp}-${p}` }),
  });
}

const r = (n) => Math.round(n * 10) / 10;
const result = {
  alerts: ALERTS,
  concurrency: CONCURRENCY,
  problems: PROBLEMS,
  seconds: r(seconds),
  throughputPerSecond: r(ALERTS / seconds),
  statuses,
  decisions,
  clientLatencyMs: { p50: r(percentile(latencies, 50)), p95: r(percentile(latencies, 95)), p99: r(percentile(latencies, 99)), max: r(latencies.at(-1) ?? 0) },
  serverLatencyMs: server?.latencyMs ?? null,
  checks,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  log(`\n${ALERTS} alerts in ${result.seconds} s  →  ${result.throughputPerSecond} alerts/s`);
  log(`status codes   ${Object.entries(statuses).map(([s, n]) => `${s}×${n}`).join("  ")}`);
  log(`decisions      ${Object.entries(decisions).map(([d, n]) => `${d} ${n}`).join("  ")}`);
  log(`latency (client, incl. network)  p50 ${result.clientLatencyMs.p50} ms  p95 ${result.clientLatencyMs.p95} ms  p99 ${result.clientLatencyMs.p99} ms  max ${result.clientLatencyMs.max} ms`);
  if (server?.latencyMs) {
    log(`latency (API, /admin/ingestion)  p50 ${server.latencyMs.p50} ms  p95 ${server.latencyMs.p95} ms  p99 ${server.latencyMs.p99} ms`);
  }
  for (const [name, ok] of Object.entries(checks)) log(`${ok ? "✓" : "✗"} ${name}`);
  if ((statuses[429] ?? 0) > 0) log("\n429s: the flood guard limited the run — restart the API with FLOOD_GUARD_PER_MINUTE=1000000.");
}
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
