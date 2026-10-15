// npm run demo:incident [-- --speed 2] [-- --respond]
//
// Plays "Checkout outage" (packages/shared/src/demo.ts) against a running
// platform, as each service's monitoring would: real HTTP requests to
// POST /api/v1/alerts with that service's API key. Watch the dashboard while
// it runs.
//
//   00:00  WARNING   checkout-api      CPU > 85% on checkout-7f9c            recorded
//   00:03  WARNING   checkout-api      Checkout p99 latency 1800ms           INC-64 opened (SEV3)
//   00:05  HIGH      checkout-api      Checkout error rate exceeded …        INC-65 opened (SEV2)
//   ...
//
// --respond also plays the people: Sam acknowledges, investigates, writes
// notes, mitigates; monitoring clears the alerts; the incidents are resolved
// and an AI postmortem draft is requested — the whole lifecycle, hands-off.
//
// Env: IRP_API_URL (default http://localhost:4000); IRP_KEYS as JSON
// {"checkout-api":"ir_live_…"} (default: the seeded dev keys); IRP_RESPONDER
// / IRP_PASSWORD for --respond (default sam@acme.test / password123).
import { IncidentApiError, IncidentClient, type AlertResult } from "@incident-platform/sdk";
import { incidentRef, PRODUCTION_INCIDENT, simulatedAlert } from "@irp/shared";
import { formatClock, parseArgs, planResponse, type ResponseStep } from "./demo-plan";

const args = parseArgs(process.argv.slice(2));
const baseUrl = process.env.IRP_API_URL ?? "http://localhost:4000";
const keys: Record<string, string> = process.env.IRP_KEYS ? JSON.parse(process.env.IRP_KEYS) : {};
const keyFor = (service: string) => keys[service] ?? `ir_live_dev_${service.replace(/-/g, "_")}`;
const clients = new Map<string, IncidentClient>();
const client = (service: string) => {
  if (!clients.has(service)) clients.set(service, new IncidentClient({ baseUrl, apiKey: keyFor(service) }));
  return clients.get(service)!;
};

const runId = `cli_${Date.now().toString(36)}`;
const started = Date.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (at: number) => {
  const wait = started + (at * 1000) / args.speed - Date.now();
  if (wait > 0) await sleep(wait);
};
const color = { dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const SEVERITY_COLOR: Record<string, string> = { CRITICAL: color.red, HIGH: color.red, WARNING: color.yellow, INFO: color.cyan };
const log = (at: number, ...parts: string[]) => console.log(`${color.dim}${formatClock(at)}${color.reset}  ${parts.join("  ")}`);

function outcome(result: AlertResult) {
  const ref = result.incident ? incidentRef(result.incident.number) : "";
  const sev = result.incident ? result.incident.severity.toUpperCase() : "";
  switch (result.decision) {
    case "incident_created":
      return `${color.red}${ref} opened (${sev})${color.reset}`;
    case "grouped":
      return `grouped into ${ref} (${sev}, ${result.incident!.alertCount} alerts)`;
    default:
      return `${color.dim}${result.decision}${color.reset}`;
  }
}

async function playAlerts() {
  const opened = new Map<string, number>(); // dedup key → incident number
  console.log(`\n${PRODUCTION_INCIDENT.name}: ${PRODUCTION_INCIDENT.description}`);
  console.log(`${color.dim}API ${baseUrl} · speed ×${args.speed} · run ${runId}${color.reset}\n`);
  for (const step of PRODUCTION_INCIDENT.steps) {
    await waitUntil(step.at);
    const alert = simulatedAlert(step, runId);
    const sev = String(alert.severity).toUpperCase();
    try {
      const result = await client(alert.service).alert({ ...alert, severity: alert.severity as "CRITICAL" });
      if (result.incident && step.alert.deduplicationKey) opened.set(step.alert.deduplicationKey, result.incident.number);
      log(step.at, `${SEVERITY_COLOR[sev] ?? ""}${sev.padEnd(8)}${color.reset}`, alert.service.padEnd(17), alert.title.slice(0, 40).padEnd(40), outcome(result));
    } catch (err) {
      const reason = err instanceof IncidentApiError ? `${err.status} ${err.message}` : (err as Error).message;
      log(step.at, `${sev.padEnd(8)}`, alert.service.padEnd(17), alert.title.slice(0, 40).padEnd(40), `${color.red}failed: ${reason}${color.reset}`);
    }
  }
  return opened;
}

// The responders' side, over the same REST API the dashboard uses.
async function playResponse(opened: Map<string, number>) {
  const email = process.env.IRP_RESPONDER ?? "sam@acme.test";
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: process.env.IRP_PASSWORD ?? "password123" }),
  });
  if (!login.ok) throw new Error(`Could not sign in as ${email} (${login.status})`);
  const { token, user } = (await login.json()) as { token: string; user: { name: string } };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: json as Record<string, unknown> };
  };

  const plan = planResponse(opened, PRODUCTION_INCIDENT.steps.at(-1)!.at);
  console.log(`\n${color.dim}— responders (${user.name}) —${color.reset}`);
  for (const step of plan) {
    await waitUntil(step.at);
    const result = await perform(step, call);
    log(step.at, `${color.green}${step.who.padEnd(8)}${color.reset}`, step.label.padEnd(58), result);
  }
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;

async function perform(step: ResponseStep, call: Call) {
  if (step.kind === "clear-alerts") {
    const cleared = await Promise.all(step.keys.map(([service, key]) => client(service).resolve({ deduplicationKey: key }).catch(() => null)));
    return cleared.map((r) => r?.resolvedCount ?? 0).reduce((a, b) => a + b, 0) + " alert(s) cleared";
  }
  const res = await call(step.method, step.path, step.body);
  if (res.ok) return step.kind === "draft" ? `draft requested → http://localhost:3000/incidents/${step.number}/postmortem` : "ok";
  if (res.status === 409 && /'resolved' is final/.test(String(res.body.error))) {
    return `${color.dim}already resolved — the service auto-resolves when monitoring clears its alerts${color.reset}`;
  }
  // Already acknowledged by someone in the UI, … — fine in a demo.
  return `${color.dim}${res.status} ${String(res.body.error ?? "")}${color.reset}`;
}

async function main() {
  const opened = await playAlerts();
  if (args.respond) await playResponse(opened);
  else console.log(`\nOpen http://localhost:3000 to respond — or run again with --respond to play the responders too.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
