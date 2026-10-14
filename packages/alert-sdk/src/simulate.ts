// Plays out "our checkout service is down" against a running API, using the
// seeded API keys:
//
//   npm run simulate                 # checkout outage scenario
//   npm run simulate -- recover      # resolve its alerts again
//   npm run simulate -- noise        # INFO/WARNING noise, staging alert, latency rule
//   npm run simulate -- storm        # 4 repeats of one alert -> 1 incident; HIGH then CRITICAL raises severity
//   npm run simulate -- burst        # 150 alerts in a row: watch the rate limit kick in
//
// Options via env: IRP_API_URL (default http://localhost:4000),
// IRP_API_KEY (default: the seeded checkout-api key).
import { AlertApiError, AlertClient, type TriggerInput } from "./index";

const baseUrl = process.env.IRP_API_URL ?? "http://localhost:4000";
const apiKey = process.env.IRP_API_KEY ?? "ir_live_dev_checkout_api";
const client = new AlertClient({ baseUrl, apiKey });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const outage: TriggerInput[] = [
  {
    service: "checkout-api",
    severity: "CRITICAL",
    title: "Checkout error rate exceeded threshold",
    description: "Error rate reached 38%",
    source: "prometheus",
    deduplicationKey: "checkout-errors",
    metadata: { errorRate: 38, region: "eu-west-1" },
  },
  {
    service: "checkout-api",
    severity: "CRITICAL",
    title: "Checkout error rate exceeded threshold",
    description: "Error rate reached 44%", // same deduplication key: grouped
    source: "prometheus",
    deduplicationKey: "checkout-errors",
    metadata: { errorRate: 44, region: "eu-west-1" },
  },
  {
    service: "checkout-api",
    severity: "HIGH",
    title: "Payment provider timeouts",
    description: "140 timeouts/min calling the card processor",
    source: "datadog",
    deduplicationKey: "checkout-payments-timeouts",
    metadata: { timeoutsPerMinute: 140 },
  },
];

async function main() {
  const scenario = process.argv[2] ?? "outage";
  const log = (label: string, result: unknown) => console.log(label.padEnd(36), JSON.stringify(result));

  if (scenario === "outage") {
    for (const alert of outage) {
      log(`${alert.severity} ${alert.title.slice(0, 26)}`, await client.trigger(alert));
      await sleep(1000);
    }
  } else if (scenario === "recover") {
    log("resolve checkout-errors", await client.resolve({ deduplicationKey: "checkout-errors" }));
    log("resolve payments-timeouts", await client.resolve({ deduplicationKey: "checkout-payments-timeouts" }));
  } else if (scenario === "noise") {
    log("INFO (recorded)", await client.trigger({ severity: "INFO", title: "Deploy 2026.10.14-1 finished", source: "argo" }));
    log("WARNING (recorded)", await client.trigger({ severity: "WARNING", title: "CPU > 80%", source: "node-exporter" }));
    log("staging (suppressed by rule)", await client.trigger({ severity: "CRITICAL", title: "Smoke test failed", source: "staging-probe" }));
    log("latency WARNING (rule -> SEV3)", await client.trigger({ severity: "WARNING", title: "Checkout p99 latency 1800ms", source: "prometheus" }));
  } else if (scenario === "storm") {
    // Correlation: the same problem reported again and again is one incident.
    for (const errorRate of [12, 19, 27, 38]) {
      const result = await client.trigger({
        service: "checkout-api",
        severity: "CRITICAL",
        title: "Checkout API elevated error rate",
        description: `Error rate reached ${errorRate}%`,
        source: "prometheus",
        deduplicationKey: "checkout-api-errors",
        metadata: { errorRate },
      });
      log(`CRITICAL errorRate=${errorRate}%`, { decision: result.decision, incident: result.incident });
      await sleep(500);
    }
    // Severity follows the worst alert: HIGH opens a SEV2, CRITICAL raises it.
    for (const severity of ["HIGH", "CRITICAL"] as const) {
      const result = await client.trigger({
        service: "checkout-api",
        severity,
        title: "Checkout database connections exhausted",
        source: "prometheus",
        deduplicationKey: "checkout-db-pool",
      });
      log(`${severity} db pool`, { decision: result.decision, incident: result.incident });
      await sleep(500);
    }
  } else if (scenario === "burst") {
    // No retries, so the 429s are visible instead of being waited out.
    const raw = new AlertClient({ baseUrl, apiKey, maxRetries: 0 });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 150; i++) {
      try {
        await raw.trigger({ severity: "INFO", title: `Heartbeat ${i}`, source: "burst", deduplicationKey: "burst" });
        counts.accepted = (counts.accepted ?? 0) + 1;
      } catch (err) {
        const key = err instanceof AlertApiError ? String(err.status) : "error";
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    log("150 alerts sent back to back", counts);
  } else {
    console.error(`Unknown scenario "${scenario}" (use outage, recover, noise or burst)`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
