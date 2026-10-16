#!/usr/bin/env node
// End-to-end smoke test of a running stack (`docker compose up -d`):
//
//   alert ──► API ──► incident ──► worker ──► email page in Mailpit
//                                    └──► acknowledge ──► web UI serves
//
// Zero dependencies (Node 20+ fetch). Used by CI against the Docker images
// and handy after `docker compose up`:  npm run smoke
//
//   API_URL (default http://localhost:4000)   WEB_URL (http://localhost:3000)
//   MAILPIT_URL (http://localhost:8025)        INCIDENT_API_KEY (seeded dev key)

const API = process.env.API_URL ?? "http://localhost:4000";
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
const KEY = process.env.INCIDENT_API_KEY ?? "ir_live_dev_checkout_api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const step = (msg) => console.log(`${String(((Date.now() - started) / 1000).toFixed(1)).padStart(5)}s  ${msg}`);

async function waitFor(what, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.error ?? res.statusText}`);
  return body;
}

try {
  const health = await waitFor("API readiness", async () => {
    const h = await fetch(`${API}/health`).then((r) => r.json());
    return h.status === "ok" && h.workers > 0 ? h : null;
  });
  step(`API ready: postgres ${health.postgres}, redis ${health.redis}, ${health.workers} worker(s)`);

  const dedup = `smoke-${Date.now()}`;
  const alert = await json(
    await fetch(`${API}/api/v1/alerts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Idempotency-Key": dedup },
      body: JSON.stringify({
        severity: "critical",
        title: "Smoke test: checkout error rate exceeded threshold",
        source: "smoke-test",
        deduplicationKey: dedup,
      }),
    })
  );
  if (alert.decision !== "incident_created") throw new Error(`expected incident_created, got ${alert.decision}`);
  const number = alert.incident.number;
  step(`alert ${alert.id} → INC-${number} opened (${alert.incident.severity})`);

  const page = await waitFor("the page email in Mailpit", async () => {
    const res = await json(await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`"INC-${number}"`)}`));
    return res.messages?.[0];
  });
  step(`worker paged ${page.To?.[0]?.Address ?? "someone"}: "${page.Subject}"`);

  const login = await json(
    await fetch(`${API}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alex@acme.test", password: "password123" }),
    })
  );
  const auth = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };
  const acked = await json(await fetch(`${API}/api/v1/incidents/${number}/acknowledge`, { method: "POST", headers: auth }));
  step(`INC-${number} ${acked.incident.status} by ${login.user.name}`);
  await json(await fetch(`${API}/api/v1/incidents/${number}/status`, { method: "POST", headers: auth, body: JSON.stringify({ status: "resolved" }) }));
  step(`INC-${number} resolved`);

  const web = await fetch(`${WEB}/login`);
  if (!web.ok) throw new Error(`web UI answered ${web.status}`);
  step(`web UI serving (${WEB}/login → ${web.status})`);
  console.log("\nSmoke test passed.");
} catch (err) {
  console.error(`\nSmoke test FAILED: ${err.message}`);
  process.exit(1);
}
