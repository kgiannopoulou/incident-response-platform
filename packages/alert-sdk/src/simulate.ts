// Plays out "our checkout service is down" against a running API, using the
// seeded integration keys:
//
//   npm run simulate                 # checkout outage scenario
//   npm run simulate -- recover      # resolve its alerts again
//   npm run simulate -- noise        # warnings, staging noise, latency rule
//
// Options via env: IRP_API_URL (default http://localhost:4000),
// IRP_INTEGRATION_KEY (default: the seeded Checkout API key).
import { AlertClient } from "./index";

const client = new AlertClient({
  baseUrl: process.env.IRP_API_URL ?? "http://localhost:4000",
  integrationKey: process.env.IRP_INTEGRATION_KEY ?? "dev-key-checkout-api",
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const outage = [
  {
    summary: "Checkout API 5xx rate above 5% (currently 23%)",
    severity: "critical" as const,
    source: "prometheus:checkout-5xx",
    component: "checkout-api",
    details: { error_rate: 0.23, region: "eu-west-1" },
  },
  {
    summary: "Checkout API 5xx rate above 5% (currently 31%)", // same dedup key: grouped
    severity: "critical" as const,
    source: "prometheus:checkout-5xx",
    component: "checkout-api",
    details: { error_rate: 0.31, region: "eu-west-1" },
  },
  {
    summary: "Payment provider timeouts",
    severity: "error" as const,
    source: "datadog:payments",
    component: "payment-client",
    dedupKey: "checkout-payments-timeouts",
    details: { timeouts_per_min: 140 },
  },
];

async function main() {
  const scenario = process.argv[2] ?? "outage";
  const log = (label: string, result: unknown) => console.log(label.padEnd(44), JSON.stringify(result));

  if (scenario === "outage") {
    for (const alert of outage) {
      log(`trigger: ${alert.summary.slice(0, 40)}`, await client.trigger(alert));
      await sleep(1000);
    }
  } else if (scenario === "recover") {
    log("resolve: 5xx rate", await client.resolve({ summary: outage[0].summary, source: outage[0].source }));
    log("resolve: payment timeouts", await client.resolve({ summary: outage[2].summary, source: outage[2].source, dedupKey: outage[2].dedupKey }));
  } else if (scenario === "noise") {
    log("warning (recorded only)", await client.trigger({ summary: "Disk 81% full", severity: "warning", source: "node-exporter" }));
    log("staging (suppressed by rule)", await client.trigger({ summary: "Smoke test failed", severity: "critical", source: "staging-probe" }));
    log("latency warning (rule -> SEV3)", await client.trigger({ summary: "Checkout p99 latency 1800ms", severity: "warning", source: "prometheus:checkout-latency" }));
  } else {
    console.error(`Unknown scenario "${scenario}" (use outage, recover or noise)`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
