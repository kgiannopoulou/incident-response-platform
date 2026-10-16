# Testing

356 tests across five workspaces. Most of them are **integration tests against a real Postgres and
Redis**: a test database (`incidents_test`, created and migrated automatically) and separate Redis
logical databases, so transactions, row locks, triggers, unique indexes and BullMQ behave exactly as
in production. Nothing about the database is mocked.

```sh
docker compose up -d postgres redis   # Postgres 5435, Redis 6380
npm test                    # everything
npm run test:unit           # no services needed
npm run test:integration    # API + worker
npm run test:coverage       # with a coverage summary per workspace
npm test -w @irp/api -- business-rules      # one file
```

| Workspace | Tests | Kind | Statements | Branches | Lines |
| --- | ---: | --- | ---: | ---: | ---: |
| `apps/api` | 182 | integration (HTTP via supertest, real DB/Redis) | 92% | 83% | 95% |
| `apps/worker` | 54 | integration (real BullMQ workers, scripted model client) | 86% | 71% | 89% |
| `packages/shared` | 90 | unit (pure domain logic, investigator engine) | 92% | 73% | 93% |
| `packages/alert-sdk` | 23 | unit (fake `fetch`, Web Crypto verifier) + end-to-end in `apps/api` | 83% | 80% | 87% |
| `apps/simulator` | 7 | unit (scenario, CLI parsing, responder script) | 100% | 95% | 100% |

Coverage excludes the process entry points (`apps/api/src/index.ts`, `apps/worker/src/index.ts`) and
the two simulator CLIs, which wire things together and only run against a live stack — they're
exercised by `npm run demo:incident` rather than unit tests. CI runs the coverage job on every push
and uploads the summaries.

## The business rules that matter most

These are the tests the platform's correctness rests on. Each one is written against the public
interface (HTTP or the job handler), not internals.

### State transitions — `packages/shared/test/state-transitions.test.ts`, `apps/api/test/business-rules.test.ts`

```
triggered → acknowledged      ✓
acknowledged → investigating  ✓
investigating → resolved      ✓
resolved → investigating      ✗  (409, nothing changes)
```

- The plan's table, as a parameterized test, both on the pure state machine and **over HTTP** (the
  forbidden move returns `409 { from, to, allowed: [] }` and the row is untouched).
- **All 20 (from, to) pairs over HTTP**: exactly the 7 allowed moves succeed.
- The full 5 × 5 matrix as a readable snapshot, and **2,000 random walks**: never an invalid state,
  never backwards, resolving always possible, `resolved` absorbing.
- Already covered since phase 6: the Postgres trigger enforces the same table (`incidents.test.ts`
  checks API and database agree on all 25 pairs), and concurrent acknowledgements serialize.

### Deduplication — `apps/api/test/business-rules.test.ts`

- **100 alerts with the same key, one after another → 1 incident, 100 attached alerts**,
  1 `INCIDENT_CREATED` + 99 `ALERT_ATTACHED` timeline events.
- **The same 100 alerts all at once** → still exactly one `incident_created` decision, 99 `grouped`,
  one incident, 100 attached alerts — and **one** escalation job, so nobody is paged 100 times.
- A different key, or the same key after resolution, opens a new incident.

### Worker retries — `apps/worker/test/retries.test.ts`

Real BullMQ workers with the production job options and handlers, wired like `src/index.ts`
(dead-lettering included); only the backoff delay is shortened.

```
notification attempt 1 → failure   row stays 'queued', attempts 1
notification attempt 2 → failure   row stays 'queued', attempts 2
notification attempt 3 → success   row 'sent', attempts 3, error cleared, one email
```

- The same for **webhooks** (receiver answers 500, 500, 200 → `sent` after 3 attempts) and **AI
  drafts** (provider errors twice, then a draft).
- Every attempt failing → the row is marked `failed`, the job is dead-lettered **once** with its
  error, attempts and organization.
- The documented retry policy per queue (5 × 2 s, 5 × 5 s, 3 × 15 s, …).

### Authorization — `apps/api/test/authorization.test.ts`

"Org A cannot read Org B incidents", generalized:

- **Every route that takes an id** (36 of them: incidents, timeline, notes, responders, postmortem,
  action items, AI drafts, services, API keys, rules, escalation policies, webhooks, deliveries,
  dead-letter jobs) is called by **an admin of the other organization** with Org A's ids → all `404`
  (not `403`: another tenant's ids aren't confirmed to exist), no Org A names in any error body, and a
  before/after snapshot of Org A's tables is identical.
- Every **list, feed and metric** (16 endpoints) returns none of Org A's data.
- Incident numbers are per organization: Org B's `INC-1` is its own, and acting on it never touches
  Org A's `INC-1`.
- **API keys are tenant-bound**: Org B's key can't alert as an Org A service (`403`) or resolve its
  alerts.
- **Roles**: 16 admin-only routes refuse responders (`403`); every session route refuses anonymous
  requests (`401`).
- Live updates: `realtime.test.ts` checks that SSE events only reach the organization they belong to.

## What these tests found

Writing tests for the rules above turned up two problems, both fixed in the same commit as the tests:

1. **A deadlock under an alert burst.** With 100 concurrent alerts for one key, Postgres reported
   deadlocks every run (10 concurrent never triggered it). Every in-flight alert holds a `KEY SHARE`
   lock on its service row through the `alerts.service_id` foreign key; the transaction that opened
   the incident held the organization's counter row and then asked for the service row
   `FOR UPDATE` (to update its status), which conflicts with `KEY SHARE` — while those alert
   transactions were queued on the counter row. The status update doesn't touch key columns, so the
   right lock is `FOR NO KEY UPDATE`, which doesn't conflict with foreign-key share locks. Admin edits
   of services, API keys and policies used the same over-strong lock (they didn't deadlock, but
   blocked ingestion) and were changed too.
2. **An inconsistent tenant check.** `GET /services/:id/rules` answered another organization's
   service id with `200` and an empty list instead of `404`. No data leaked (the query was already
   tenant-scoped), but it was the only route that didn't treat a foreign id as nonexistent.

## Failure handling — `apps/api/test/failure-handling.test.ts`, `apps/worker/test/failure-handling.test.ts`

The app is built against a Redis and a Postgres that are *down* (nothing listening on the port) to
check that alerts are still accepted in under 1.5 s without Redis, that a database outage is a fast
`503` + `Retry-After`, and that `/health` vs `/health/live` report it correctly. A third test kills
the pool's Postgres backends with `pg_terminate_backend`, as a restart or failover would, and checks
the next alert succeeds — before Phase 21 that crashed the process (no `error` listener on the pool).
Idempotency: a repeat, 10 concurrent copies, a reused key with another body, per-service scope, 24 h
expiry, and the SDK retrying after a response that was committed but never arrived. Worker side:
5 concurrent deliveries of one page → one email, 3 of one webhook → one POST, a failed attempt
releasing its lease, and a "crashed" worker's lease being respected and then re-driven once.
See [failure-handling.md](failure-handling.md).

## Security — `apps/api/test/security.test.ts`

The controls in the [threat model](threat-model.md), attacked through the app: security headers and
`no-store`; CORS only for the web origin; the session cookie's `HttpOnly` / `SameSite=Strict`; CSRF
(a cookie-authenticated acknowledge from another origin, from no origin, or with a foreign Referer is
`403` and changes nothing; the web origin works; Bearer clients and API-key ingestion are unaffected;
login CSRF; a `text/plain` body is never parsed); password guessing (account locked after 10
failures *even for the right password*, other accounts unaffected, failures audited, identical
answers for unknown emails); forged tokens (`alg: none`, foreign secret, HS512, wrong audience,
expired); the weak-secret start-up check; SQL injection payloads stored literally in every alert
field and hostile query strings answered with `400`/`404`/empty results. Writing them found two
bugs, both fixed: `?serviceId=1 OR 1=1` and an oversized body each produced a `500` instead of a
`400`/`413`. The worker suite adds an SSRF test where the URL says `localhost` and only the resolved
address reveals it is internal; the SDK suite checks its Web Crypto verifier against signatures made
by the platform's `node:crypto` signer.

## AI Incident Investigator — `packages/shared/test/investigation.test.ts`, `apps/worker/test/investigator.test.ts`, `apps/api/test/investigations.test.ts`

The correlation engine on the demo story (the deploy ranked first with its evidence, Postgres as a
probable symptom, the unrelated auth deploy last at low confidence), a dependency that failed first
with nothing changed, a deploy *after* the errors started (contradicted), and no evidence at all
(says so). Citation validation against the ledger. Against real Postgres: the evidence store sees
only the incident's organization (another tenant's tempting deployment never appears), groups logs
into patterns with a baseline, redacts `password=` and emails, escapes `LIKE` wildcards. The Claude
agent runs against a scripted client, so the tests pin down the exact requests (model, fallback beta,
strict tool schemas, the fenced brief), that the assistant turn goes back unchanged with one
`tool_result` per call, that a foreign service name returns nothing, invalid tool input and unknown
tools come back as tool errors, the tool budget holds, an invented citation is removed with a
warning, prose instead of `submit_findings` gets one nudge and then fails, and refusals fail without
retries while transient errors are left to BullMQ. API side: deployment and log ingestion with API
keys, dependencies (admin, same tenant, not self), one investigation in flight, posting a hypothesis
as an attributed, unconfirmed note, and tenant isolation.

## Other suites

Phase by phase, the rest of the suite covers API keys (hashing, rotation, revocation, rate limits),
correlation and rules, the immutable hash-chained timeline, realtime replay, responders and roles,
escalation policies and acknowledgement timeouts, notifications and signed webhooks, the dead-letter
queue, postmortems, AI drafts (redaction, citations, the review gate, the Claude request shape),
dashboard metrics, the simulator and the SDK (including end to end over HTTP). The README's
[Testing](../README.md#testing) section lists them.
