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
// Everything a simulation sends is tagged metadata.simulated = true.

export type DemoStep = {
  at: number; // seconds from the start
  label: string; // what the progress strip says
  alert: AlertPayloadInput & { service: string; title: string };
};

export type DemoScenario = { id: string; name: string; description: string; steps: DemoStep[] };

const checkoutErrors = (errorRate: number, severity: "HIGH" | "CRITICAL"): DemoStep["alert"] => ({
  service: "checkout-api",
  severity,
  title: "Checkout error rate exceeded threshold",
  description: `Error rate reached ${errorRate}%`,
  source: "prometheus",
  deduplicationKey: "checkout-errors",
  metadata: { errorRate, region: "eu-west-1" },
});

export const PRODUCTION_INCIDENT: DemoScenario = {
  id: "checkout-outage",
  name: "Checkout outage",
  description: "CPU and latency warnings, then checkout failures escalate to a SEV1 while the database runs out of connections.",
  steps: [
    {
      at: 0,
      label: "CPU alert",
      alert: { service: "checkout-api", severity: "WARNING", title: "CPU > 85% on checkout-7f9c", source: "node-exporter", metadata: { cpu: 91, host: "checkout-7f9c" } },
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
    { at: 5, label: "Checkout failures", alert: checkoutErrors(12, "HIGH") },
    { at: 8, label: "Critical incident", alert: checkoutErrors(38, "CRITICAL") },
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
    },
    { at: 15, label: "Failures keep coming", alert: checkoutErrors(41, "CRITICAL") },
  ],
};

export const DEMO_SPEEDS = [1, 2, 5] as const;

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
