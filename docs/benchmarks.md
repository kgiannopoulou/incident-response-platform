# Alert ingestion: load and concurrency

How fast can Fireline take alerts, what limits it, and does it stay correct under an alert storm?
Two tools answer that:

| | What it does |
| --- | --- |
| [`apps/api/test/ingestion-load.test.ts`](../apps/api/test/ingestion-load.test.ts) | Runs in CI. 400 concurrent alerts for 20 problems on two services, 200 retried deliveries with `Idempotency-Key`, and the latency recorder. Asserts the invariants, not timings |
| [`scripts/load-test.mjs`](../scripts/load-test.mjs) | `npm run loadtest` against a running stack. Reports throughput and latency percentiles from the client and from the API's own measurement, then checks the same invariants |

The API measures every `POST /alerts` itself (rejected ones included) in a bounded ring buffer
([`lib/ingestion-stats.ts`](../apps/api/src/lib/ingestion-stats.ts)). Admins see it live on the
**System** page and at `GET /api/v1/admin/ingestion?window=300`: alerts per second, p50 / p95 / p99
latency, 5xx count and the decisions taken (`incident_created`, `grouped`, `recorded`…).

## Invariants checked under load

| Invariant | Why it matters in a storm |
| --- | --- |
| Exactly one incident per open problem (deduplication key) | 2,000 repeats of "checkout is down" must page once, not 2,000 times |
| Every accepted alert attached to its incident (`alert_count` = alerts sent) | Nothing lost or double-counted |
| One escalation job per incident, enqueued after commit | One page per incident |
| Incident numbers dense: `INC-1 … INC-n`, no gaps | See the bug below |
| Retried deliveries recorded once, every retry answered with the same alert id | Senders retry on timeouts; a storm is when that happens |
| No 5xx | — |

## Results

Local run: one API process (`tsx`, `NODE_ENV=production`), Postgres 16 and Redis 7 in Docker
Desktop, load generator on the same machine (AMD Ryzen 7 5800H, 16 GB, Windows 11). Started with
`FLOOD_GUARD_PER_MINUTE=10000000` so the flood guard (1,200 requests per credential per minute by
default) doesn't cap the run. All alerts critical, so every first alert per problem opens an
incident.

```sh
npm run loadtest -- --alerts 2000 --concurrency 50 --problems 20
```

| Alerts | In flight | Problems | Throughput | API p50 | API p95 | API p99 | Client p50 | Client p95 | Checks |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 1,000 | 1 | 20 | 34 /s | 9.9 ms | 12 ms | 17 ms | 31 ms | 33 ms | ✓ |
| 2,000 | 10 | 20 | **318 /s** | 17 ms | 22 ms | 39 ms | 30 ms | 37 ms | ✓ |
| 2,000 | 50 | 20 | 345 /s | 121 ms | 144 ms | 337 ms | 137 ms | 160 ms | ✓ |
| 2,000 | 100 | 20 | 341 /s | 262 ms | 328 ms | 459 ms | 278 ms | 356 ms | ✓ |
| 2,000 | 50 | 200 | 276 /s | 122 ms | 496 ms | 663 ms | 138 ms | 513 ms | ✓ |
| 1,000 | 50 | 1 | 162 /s | 288 ms | 339 ms | 366 ms | 300 ms | 355 ms | ✓ |

"API" latency is measured by the API from the alert route being reached to the response being
written; "client" adds the HTTP round trip, body parsing and the middleware in front of the route.

## What the numbers say

- **One API process saturates at ~340 alerts/s.** Throughput is flat from 10 to 100 requests in
  flight; past that point more concurrency only adds queueing (p50 grows from 17 ms to 262 ms).
  Every alert is one Postgres transaction with several statements (key lookup, idempotency claim,
  correlation, insert, incident update, timeline event, audit row), so the single Node process and
  its connection pool are the limit. The API is stateless, so this scales out horizontally — Redis
  already carries the SSE fan-out and rate limits between instances.
- **A single hot problem is slower (162 /s).** 1,000 alerts for one deduplication key all update the
  same incident row (`alert_count`, `last_alert_at`), and that row lock serialises them. That's the
  price of an exact count; batching repeats into periodic updates would trade exactness for speed.
- **Many new problems cost more at the tail (p99 663 ms with 200 problems).** Opening an incident
  increments the organization's incident counter under a row lock (gapless `INC-` numbers), so
  incident *creation* is serialised per organization. Grouping into an existing incident isn't.
- **At 1 request in flight**, an alert takes ~10 ms inside the API.

## A bug the load test found

The first run of the storm test failed on the incident numbers: `1, 2, 3, 5, 6, 7, 8, 9, 11, …`.

When two requests race to open an incident for the same key, both increment the organization's
counter, and the loser's `INSERT … ON CONFLICT DO NOTHING` returns nothing — it then correctly joins
the winner's incident, but its increment was still committed, so a number was lost. Correctness of
deduplication was never affected (one incident per key held), but `INC-4` simply never existed.

The fix ([`domain/incidents.ts`](../apps/api/src/domain/incidents.ts)): the loser gives the number
back. That is safe because its `UPDATE … RETURNING` still holds the organization's row lock, so no
one can have taken a later number in between. The storm test now asserts dense numbers on every run.

## Reproducing

```sh
docker compose up -d postgres redis mailpit
npm run db:migrate && npm run db:seed
FLOOD_GUARD_PER_MINUTE=10000000 npm run dev:api     # in another terminal
npm run loadtest -- --alerts 2000 --concurrency 50 --problems 20
npm run loadtest -- --alerts 2000 --concurrency 50 --problems 20 --json   # machine-readable
```

The script logs in as the seeded admin, creates a throwaway service with its own key (no escalation
policy, so nobody is paged), and resolves its incidents again at the end. Leave ~10 s between runs
so the API's 10-second-minimum measurement window doesn't include the previous run.
