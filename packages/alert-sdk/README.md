# @incident-platform/sdk

Send alerts to the incident platform from any Node.js 18+ application — no runtime dependencies.

```
Application
    │
    │ SDK  ── alert / resolve / captureException / monitor (retries, timeouts)
    ▼
Alert API  ── POST /api/v1/alerts, API key, rate limits
    │
    ▼
Incident Engine  ── dedup, rules, incidents, paging, escalation
```

## Quick start

```ts
import { IncidentClient } from "@incident-platform/sdk";

const incidents = new IncidentClient({
  apiKey: process.env.INCIDENT_API_KEY!,
});

await incidents.alert({
  severity: "critical",
  title: "Database connection failure",
  deduplicationKey: "db-connection",
});
```

Every repeat with the same `deduplicationKey` joins the open incident instead of opening a new one.
When the problem is gone, clear it, and services with auto-resolve close the incident:

```ts
await incidents.resolve("db-connection");
```

## Exceptions

```ts
try {
  await chargeCard(order);
} catch (err) {
  await incidents.captureException(err, { severity: "critical", metadata: { orderId: order.id } });
  throw err;
}
```

The title is `<ErrorName>: <message>`, the description is the stack, and the deduplication key is a
**fingerprint** of the error type, the message with numbers/ids/quoted values masked, and the
function + file it was thrown from (not the line, so a redeploy doesn't open new incidents). A
thousand `Card processor timeout after 3000ms for order 4711` errors are one incident with a thousand
alerts.

## Jobs

```ts
await incidents.monitor("nightly-billing", () => runBilling(), { severity: "high" });
```

Runs the job; if it throws, raises `nightly-billing failed: <message>` (key `monitor:nightly-billing`)
and re-throws. The next successful run resolves that key (turn off with `resolveOnSuccess: false`).

## Options

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `INCIDENT_API_KEY` | `ir_live_…` key of the service you're alerting for |
| `baseUrl` | `INCIDENT_API_URL`, else `http://localhost:4000` | |
| `source` | `"sdk"` | Default `source` of your alerts (e.g. the service name) |
| `defaultMetadata` | `{}` | Merged into every alert (`region`, `version`, …) |
| `timeoutMs` | `10000` | Per attempt |
| `maxRetries` | `3` | For network errors, timeouts, 5xx and 429 |
| `baseDelayMs` | `250` | Exponential backoff: 250 ms, 500 ms, 1 s… (a 429 waits for `Retry-After`, up to `maxRetryAfterMs`) |
| `idempotencyKey` *(per call)* | random per call | `alert({ …, idempotencyKey })` — sent as `Idempotency-Key`, reused on retries |
| `onError` | `"throw"` | `"log"` or `(err) => void` to resolve to `null` instead of rejecting — alerting should never crash your app |

`alert()` resolves to what the platform decided:

```ts
{
  id: "alert_01J…", status: "triggered", receivedAt: "2026-10-15T14:02:11Z",
  service: "checkout-api", deduplicationKey: "db-connection",
  decision: "incident_created",            // | "grouped" | "recorded" | "suppressed" | "maintenance" | "resolved"
  reason: "Default rule: critical/high alerts open an incident",
  incident: { id: 65, number: 65, status: "triggered", severity: "sev1", alertCount: 1 }
}
```

The return type follows `onError`: with `"throw"` it's `AlertResult`, otherwise `AlertResult | null`.

## Errors

- `IncidentClientError` — the call was invalid before anything was sent (no API key, unknown
  severity, empty title). Always thrown, whatever `onError` says.
- `IncidentApiError` — `status` (`0` for network errors and timeouts), `message` from the API,
  `retryAfterSeconds`. 4xx responses other than 429 (revoked key, invalid payload, wrong service)
  are not retried.

Retrying is safe. Every `alert()` call sends one `Idempotency-Key` header (a random UUID) and reuses
it on each of its retries, so if an attempt was committed but its response was lost — a timeout, a
dropped connection — the platform replays the stored response (`replayed: true`) instead of
recording the alert twice. Pass `idempotencyKey` yourself (for example your monitoring event's id)
to make repeats safe across processes too. Even without it, a repeated alert lands in the same
incident through its deduplication key.

## Verifying webhooks

Fireline signs every outgoing webhook (`Fireline-Signature: t=…,v1=…`, HMAC-SHA256 of
`timestamp.body`). Verify on the **raw** body, then dedupe on the event `id` (deliveries are
at-least-once):

```ts
import { constructWebhookEvent, WebhookSignatureError } from "@incident-platform/sdk";

try {
  const event = await constructWebhookEvent(process.env.FIRELINE_WEBHOOK_SECRET!, rawBody, req.headers["fireline-signature"]);
  if (await alreadyProcessed(event.id)) return res.status(200).end();
  // event.event === "incident.triggered", event.incident.id === "INC-142", …
} catch (err) {
  if (err instanceof WebhookSignatureError) return res.status(401).end(); // forged, modified or replayed
  throw err;
}
```

`verifyWebhookSignature()` returns a boolean instead. Signatures older than 5 minutes are rejected
(`toleranceSeconds`). It uses Web Crypto, so it works on Node, Deno, Bun and edge runtimes, and the
comparison is constant-time. `npm run example:webhooks -w @incident-platform/sdk` runs
[a complete receiver](examples/webhook-receiver.ts).

## Example

[`examples/checkout-service.ts`](examples/checkout-service.ts) is a small HTTP service that reports
failed checkouts with `captureException` and watches its database with `monitor`:

```sh
npm run example -w @incident-platform/sdk
curl -X POST localhost:3100/checkout      # a third of requests fail → one grouped incident
curl -X POST localhost:3100/db/down       # the health check starts alerting; /db/up resolves it
```

## Development

In this monorepo the package resolves to its TypeScript source through the
`@incident-platform/source` export condition (`customConditions` in `tsconfig.base.json`,
`tsx --conditions=…` in scripts). `npm run build` compiles `dist/` (ESM + `.d.ts`), which is what the
published package ships; `npm pack --dry-run` shows the contents.
