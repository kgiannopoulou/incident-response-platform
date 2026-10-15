// A tiny "checkout service" instrumented with the SDK:
//
//   npm run example -w @incident-platform/sdk
//   curl -X POST localhost:3100/checkout      (a third of requests fail)
//
// - Failed checkouts are reported with captureException: hundreds of
//   failures of the same bug become one incident (same fingerprint).
// - A health check runs every 10 s under monitor("checkout-db-health"):
//   it alerts when the check throws and clears the alert when it recovers,
//   so the incident auto-resolves. Toggle the "database" with POST /db/down
//   and POST /db/up.
// - onError: "log" — if the incident platform is unreachable, the service
//   logs and carries on; alerting never takes checkout down with it.
//
// Uses INCIDENT_API_KEY / INCIDENT_API_URL, defaulting to the seeded
// checkout-api key on a local platform.
import { createServer } from "node:http";
import { IncidentClient } from "@incident-platform/sdk";

const incidents = new IncidentClient({
  apiKey: process.env.INCIDENT_API_KEY ?? "ir_live_dev_checkout_api",
  source: "checkout-service",
  defaultMetadata: { region: "eu-west-1", version: "1.4.2" },
  onError: "log",
});

let databaseUp = true;

class CardProcessorTimeout extends Error {
  name = "CardProcessorTimeout";
}

async function placeOrder(orderId: number) {
  if (Math.random() < 0.33) throw new CardProcessorTimeout(`Card processor did not answer within 3000ms for order ${orderId}`);
  return { orderId, status: "confirmed" };
}

async function checkDatabase() {
  if (!databaseUp) throw new Error("connection refused (pool 500/500)");
}

let nextOrder = 1000;
const server = createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && req.url === "/checkout") {
    const orderId = nextOrder++;
    try {
      return reply(200, await placeOrder(orderId));
    } catch (err) {
      const result = await incidents.captureException(err, { severity: "critical", metadata: { orderId } });
      return reply(502, { error: (err as Error).message, incident: result?.incident ?? null });
    }
  }
  if (req.method === "POST" && (req.url === "/db/down" || req.url === "/db/up")) {
    databaseUp = req.url === "/db/up";
    return reply(200, { databaseUp });
  }
  reply(404, { error: "POST /checkout, /db/down or /db/up" });
});

setInterval(() => {
  incidents.monitor("checkout-db-health", checkDatabase, { severity: "critical" }).catch((err) => console.warn(`db health: ${err.message}`));
}, 10_000);

server.listen(3100, () => console.log("checkout-service on http://localhost:3100 — POST /checkout, /db/down, /db/up"));
