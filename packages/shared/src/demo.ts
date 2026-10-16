import type { DeploymentPayload } from "./investigation";
import type { AlertPayloadInput } from "./schemas";

// "Simulate a production incident" — so nobody needs real infrastructure to
// see the platform work. One scenario, played two ways:
//
//   npm run demo:incident              sends these alerts over HTTP with the services' API keys
//                                      (optionally also plays the responders: --respond)
//   [ Simulate production incident ]   dashboard button: the API feeds the same alerts through
//                                      its ingestion pipeline, with live progress
//
// The story (offsets in seconds at speed 1):
//
//   00:00  CPU > 85% on a checkout node         WARNING  → recorded, nobody paged
//   00:03  checkout p99 latency 1800 ms         WARNING  → "latency" rule → SEV3 incident
//   00:05  checkout 5xx rate 12%                HIGH     → SEV2 incident, Payments team paged
//   00:08  checkout 5xx rate 38%                CRITICAL → same dedup key: grouped, raised to SEV1
//   00:12  DB connection pool exhausted         CRITICAL → SEV1 on PostgreSQL Primary
//   00:15  checkout 5xx rate 41%                CRITICAL → grouped (Alerts: 3)
//
// Before the first alert, the scenario reports what changed (CI/CD
// deployments: checkout-api v2.14.0 six minutes earlier, raising worker
// concurrency 8 → 32 per pod; an unrelated auth-service deploy) and a
// baseline of ordinary warnings; with the alerts come the application logs
// — new "timeout acquiring connection" errors on checkout, "too many
// connections" on Postgres. That's the evidence the incident investigator
// connects: the deploy multiplied checkout's database connections until
// Postgres ran out.
//
// Everything a simulation sends is tagged metadata.simulated = true.

export type DemoLog = {
  service: string;
  level: "warn" | "error" | "fatal";
  message: string; // "{n}" is replaced by a varying number
  count: number;
  secondsBefore?: number; // spread over this many seconds before the step (default 20)
};

export type DemoStep = {
  at: number; // seconds from the start
  label: string; // what the progress strip says
  alert: AlertPayloadInput & { service: string; title: string };
  logs?: DemoLog[];
};

export type DemoChange = { service: string; minutesBefore: number; deployment: Omit<DeploymentPayload, "startedAt" | "finishedAt" | "environment" | "metadata" | "description"> & { description: string } };

export type DemoScenario = {
  id: string;
  name: string;
  description: string;
  changes?: DemoChange[]; // reported before the first step
  baselineLogs?: (DemoLog & { minutesBefore: number })[]; // ordinary noise from before the incident
  steps: DemoStep[];
};

const checkoutErrors = (errorRate: number, severity: "HIGH" | "CRITICAL"): DemoStep["alert"] => ({
  service: "checkout-api",
  severity,
  title: "Checkout error rate exceeded threshold",
  description: `Error rate reached ${errorRate}%`,
  source: "prometheus",
  deduplicationKey: "checkout-errors",
  metadata: { errorRate, region: "eu-west-1" },
});

const poolTimeouts = (count: number): DemoLog => ({
  service: "checkout-api",
  level: "error",
  message: "timeout acquiring connection from pool after 5000ms (order {n})",
  count,
});

export const PRODUCTION_INCIDENT: DemoScenario = {
  id: "checkout-outage",
  name: "Checkout outage",
  description: "CPU and latency warnings, then checkout failures escalate to a SEV1 while the database runs out of connections.",
  changes: [
    {
      service: "checkout-api",
      minutesBefore: 26 * 60,
      deployment: { version: "v2.13.4", kind: "deploy", status: "succeeded", author: "Sam Rivera", commitSha: "4be1d07", description: "Retry card authorisation once on gateway timeout" },
    },
    {
      service: "auth-service",
      minutesBefore: 50,
      deployment: { version: "v5.2.1", kind: "deploy", status: "succeeded", author: "Riley Chen", commitSha: "9c03aa1", description: "Rotate session signing keys" },
    },
    {
      service: "checkout-api",
      minutesBefore: 6,
      deployment: {
        version: "v2.14.0",
        kind: "deploy",
        status: "succeeded",
        author: "Jordan Lee",
        commitSha: "e41f9b2",
        description: "Raise checkout worker concurrency 8 → 32 per pod for the Black Friday load test",
      },
    },
  ],
  baselineLogs: [
    { service: "checkout-api", level: "warn", message: "slow query: SELECT * FROM carts WHERE id = {n} took {n}ms", count: 6, minutesBefore: 40 },
    { service: "postgres-primary", level: "warn", message: "checkpoints are occurring too frequently ({n} seconds apart)", count: 2, minutesBefore: 35 },
    { service: "auth-service", level: "warn", message: "token refresh for client {n} took {n}ms", count: 4, minutesBefore: 30 },
  ],
  steps: [
    {
      at: 0,
      label: "CPU alert",
      alert: { service: "checkout-api", severity: "WARNING", title: "CPU > 85% on checkout-7f9c", source: "node-exporter", metadata: { cpu: 91, host: "checkout-7f9c" } },
      logs: [{ service: "checkout-api", level: "warn", message: "worker pool saturated: 32/32 workers busy, {n} jobs queued", count: 8 }],
    },
    {
      at: 3,
      label: "API latency alert",
      alert: {
        service: "checkout-api",
        severity: "WARNING",
        title: "Checkout p99 latency 1800ms",
        description: "p99 above the 1s SLO for 5 minutes",
        source: "prometheus",
        deduplicationKey: "checkout-latency",
        metadata: { p99Ms: 1800 },
      },
    },
    { at: 5, label: "Checkout failures", alert: checkoutErrors(12, "HIGH"), logs: [poolTimeouts(40)] },
    { at: 8, label: "Critical incident", alert: checkoutErrors(38, "CRITICAL"), logs: [poolTimeouts(90)] },
    {
      at: 12,
      label: "Database connection alert",
      alert: {
        service: "postgres-primary",
        severity: "CRITICAL",
        title: "Connection pool exhausted (500/500)",
        description: "New connections are being refused",
        source: "pg-exporter",
        deduplicationKey: "pg-connections",
        metadata: { active: 500, max: 500 },
      },
      logs: [
        { service: "postgres-primary", level: "fatal", message: "remaining connection slots are reserved for non-replication superuser connections", count: 25 },
        { service: "postgres-primary", level: "error", message: 'too many connections for role "checkout" ({n} active)', count: 30 },
      ],
    },
    { at: 15, label: "Failures keep coming", alert: checkoutErrors(41, "CRITICAL"), logs: [poolTimeouts(60)] },
  ],
};

export const DEMO_SPEEDS = [1, 2, 5] as const;

// Service dependencies the scenario assumes (seeded by `npm run db:seed`).
export const DEMO_DEPENDENCIES: [string, string][] = [
  ["checkout-api", "postgres-primary"],
  ["checkout-api", "auth-service"],
  ["auth-service", "postgres-primary"],
  ["iot-gateway", "postgres-primary"],
];

// Concrete log entries for one DemoLog, spread evenly before `at`.
export function demoLogEntries(log: DemoLog, at: Date, runId: string) {
  const spread = (log.secondsBefore ?? 20) * 1000;
  return Array.from({ length: log.count }, (_, i) => {
    let k = 0;
    const message = log.message.replace(/\{n\}/g, () => String(((i + 1) * 7919 + k++ * 104729) % 9000 + 1000));
    return {
      level: log.level,
      message,
      timestamp: new Date(at.getTime() - spread + Math.round((spread * i) / Math.max(1, log.count))).toISOString(),
      attributes: { simulated: true, demoRun: runId },
    };
  });
}

export const scenarioDurationSeconds = (scenario: DemoScenario) => Math.max(...scenario.steps.map((s) => s.at));

// Marks a step's alert as simulated, so nobody mistakes it for a real one.
export function simulatedAlert(step: DemoStep, runId: string): DemoStep["alert"] {
  return { ...step.alert, metadata: { ...step.alert.metadata, simulated: true, demoRun: runId } };
}

// Live progress of a dashboard-started simulation (also kept in Redis so a
// page opened mid-run can show it).
export type DemoRunState = {
  runId: string;
  scenario: string;
  startedBy: string;
  startedAt: string;
  speed: number;
  step: number; // steps done
  total: number;
  label: string; // last step done ("" before the first)
  done: boolean;
  results: { label: string; decision: string; incident: number | null }[];
};
