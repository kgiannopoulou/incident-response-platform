# Fireline — Incident Response Platform

[![CI](https://github.com/kgiannopoulou/incident-response-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/kgiannopoulou/incident-response-platform/actions/workflows/ci.yml)

A small, PagerDuty/Opsgenie-style incident management platform. Monitoring tools send
alerts; the platform deduplicates them, applies matching rules, opens incidents, pages
the on-call responder and escalates if nobody answers. Responders then work the
incident (acknowledge, investigate, mitigate, resolve) on a live timeline, and when it's resolved
a postmortem draft is generated from what actually happened.

> "Our checkout service is down." — follow it from the first automated alert →
> incident → page → escalation → acknowledgement → resolution → postmortem.

![Incident page](docs/screenshots/incident-page.jpg)

*The incident page: 4 correlated alerts in one SEV1, state-machine actions, responders by role,
and an append-only, hash-verified timeline that updates live.*

![Dashboard](docs/screenshots/dashboard.jpg)

*The dashboard during **▶ Simulate production incident**: the scenario's steps light up as alerts are
ingested, active incidents worst-first with live age, and the last 30 days — MTTA / MTTR against the
previous window, incidents per day stacked by severity, per service and per severity.*

| AI postmortem draft — a suggestion with cited events | Review gate after applying sections |
| --- | --- |
| ![AI draft](docs/screenshots/postmortem-ai-draft.jpg) | ![AI review](docs/screenshots/postmortem-ai-review.jpg) |

| Escalation, live | Acknowledgement timeout countdown |
| --- | --- |
| ![Incident with escalation](docs/screenshots/incident-escalation.jpg) | ![Acknowledgement timeout](docs/screenshots/incident-ack-timeout.jpg) |
| **Escalation policies** | **Signed webhooks with a delivery log** |
| ![Escalation policies](docs/screenshots/escalation-policies.jpg) | ![Webhooks](docs/screenshots/webhooks.jpg) |
| **Background jobs and the dead-letter queue** | **Alert feed** |
| ![System](docs/screenshots/system.jpg) | ![Alerts](docs/screenshots/alerts.jpg) |
| **API keys: rotation and revocation** | |
| ![API keys](docs/screenshots/api-keys.jpg) | |

![Postmortem](docs/screenshots/postmortem.jpg)

*A published postmortem: every timeline line comes from the incident's immutable event log —
including the missed 2-minute acknowledgement timeout that paged the team lead early — with
retrospective sections and tracked action items.*

## The workflow

```
Monitoring tool / app ──POST /api/v1/alerts──► API key (hashed lookup) ─► rate limit (token bucket)
                         Authorization: Bearer          │
                         ir_live_…                      ▼
                                                Alert ingestion
                                                    │  deduplicationKey (or service + source + title, numbers masked)
                                                    ▼
                                    open incident with the same key? ──yes──► group alert into it
                                                    │ no
                                                    ▼
                                         matching rules (ordered)
                                     ┌──────────────┼───────────────┐
                                     ▼              ▼               ▼
                               create incident   record only     suppress
                                     │
                    ┌────────────────┼──────────────────────┐
                    ▼                ▼                      ▼
             page level 1     dashboard updates       service status
             (worker)         (SSE, live)             (outage/degraded)
                    │
          not acknowledged in N min ──► escalate to level 2, 3 …
                    │
          responder acknowledges ──► investigating ──► resolved
                                                          │
                                       postmortem draft + "resolved" pages
```

## Features

- **Alert ingestion API** — `POST /api/v1/alerts` with `INFO` / `WARNING` / `HIGH` / `CRITICAL`
  severities, title, description, deduplication key and free-form metadata; returns a time-sortable
  public id (`alert_01J…`, a ULID), status and receive time. PagerDuty-style `resolve` events.
- **Alert SDK — [`@incident-platform/sdk`](packages/alert-sdk)**: `new IncidentClient({ apiKey })`
  then `alert()`, `resolve()`, `captureException()` (stack + a fingerprint that groups the same bug
  into one incident across order ids and redeploys) and `monitor("nightly-billing", job)` (alerts on
  failure, clears on recovery). Timeouts, retries with backoff, `Retry-After`, typed errors, and an
  `onError: "log"` mode so alerting can't crash the app. Zero runtime dependencies, compiled to ESM +
  `.d.ts`, packed and smoke-imported in CI; an instrumented example service ships with it.
- **API keys per service** (`ir_live_…`): generated once and **stored only as a SHA-256 hash**;
  several keys per service; **rotation** with a grace period in which old and new key both work;
  instant **revocation**; **last-used** timestamps; per-key **rate limits** (Redis token bucket, with
  `RateLimit-*` / `Retry-After` headers) and lock-out of IPs that keep sending bad keys.
- **Deduplication & correlation** — repeats of the same problem (same service + `deduplicationKey`)
  join the open incident instead of paging again: four `checkout-errors` alerts are one incident with
  `Alerts: 4`. A more severe repeat raises the incident's severity (never lowers it).
  Safe under concurrency: 10 simultaneous identical alerts open exactly one incident.
- **Matching rules** per service (first match wins): open an incident with a severity override,
  record only, or suppress (e.g. staging noise). Sensible default when no rule matches.
- **Incident lifecycle** enforced by a state machine (`triggered → acknowledged → investigating →
  mitigated → resolved`, with shortcuts to `resolved`; `resolved` is final), validated in the API *and*
  by a database trigger, with row locking so two people clicking *Acknowledge* can't both win.
- **Incident page** — the centerpiece: status, severity, live "started 14 minutes ago" and response
  times, *Acknowledge / Start investigating / Mark mitigated / Resolve* driven by the state machine,
  *Escalate* to page the next level on demand, responders, paging, grouped alerts and the timeline.
- **Responders with roles** — *Incident Commander* (exactly one, enforced by a partial unique index),
  *Responders* and read-only *Observers*. Join, observe, switch, leave; the commander (or an admin)
  hands over command and manages people. Every change lands on the timeline.
- **Escalation policies** — ordered steps (`0 min → Backend team`, `5 min without acknowledgement →
  team lead`, `10 min → engineering manager`), each paging users and/or whole teams, with delays
  anchored to when the incident triggered. Full CRUD API with validation (strictly increasing delays,
  same-organization targets) and an editor that draws the chain; acknowledging stops it, *Escalate*
  pages the next step immediately.
- **Acknowledgement timeout** — a fast lane for high-urgency incidents: if nobody acknowledges a
  SEV1/SEV2 within the policy's timeout, a delayed BullMQ job pages the next step *now* instead of at
  its scheduled time. Acknowledging clears the deadline and cancels the job; a severity raise starts
  the clock, a downgrade stops it; the sweeper catches deadlines whose job was lost. A live
  "Acknowledge in 1 min or this SEV1 escalates early" countdown, an `ACK_TIMEOUT` timeline event, an
  `incident.escalated` webhook, and a *missed ack timeouts* KPI on the dashboard.
- **Background jobs on Redis + BullMQ** — the API saves the incident and queues an
  `incident-created` job instead of paging inside the request; the worker pages and schedules the
  next step as a delayed job. Per-queue retry policies with exponential backoff, a **dead-letter
  queue** for jobs that exhausted their retries (retry / discard from the **System** page, audited),
  worker heartbeats in `/health`, graceful shutdown.
- **Notifications on two channels.** *Email* pages to people (SMTP via nodemailer; locally every
  page lands in the Mailpit inbox) with severity, service and a link to the incident. *Webhooks* for
  systems: admins register endpoints and pick events (`incident.triggered`, `.acknowledged`,
  `.escalated`, `.resolved`); each delivery is an outbox row written in the same transaction, POSTed
  as JSON signed with **HMAC-SHA256** (`Fireline-Signature: t=…,v1=…`, replay window), retried with
  backoff, dead-lettered when exhausted, auto-disabled on `410 Gone`, and visible with status codes,
  payloads, *Send test* and *Redeliver* in the UI. Optional SSRF guard for private addresses.
- **Live alert feed** (🔴 CRITICAL · 🟠 HIGH · 🟡 WARNING · 🔵 INFO, "12 sec ago") and **real-time
  updates** over Server-Sent Events: acknowledge in one window and every other window showing the
  incident flips to ACKNOWLEDGED instantly ("Alex Morgan updated this incident"). Events from the API
  *and* the worker go through Redis (pub/sub + a capped Stream), carry ids, and are **replayed after a
  reconnect** via `Last-Event-ID`, with a resync fallback.
- **Immutable timeline + audit trail** — every action is a typed timeline event (`INCIDENT_CREATED`,
  `STATUS_CHANGED {from,to}`, `NOTE_ADDED`, …). The timeline is append-only — no API to edit it, and
  Postgres triggers reject `UPDATE`/`DELETE` — and hash-chained, so tampering is detectable. Every
  change in the organization is also written to the audit log in the same transaction.
- **Postmortems** — drafted automatically on resolve as a full document: incident, duration
  ("37 minutes"), severity (SEV-1), summary, impact, **timeline built from the immutable event log**
  (key events only, alert storms collapsed, every entry linked to its event id and hash; entries can be
  hidden from the document but never edited), root cause, resolution, *what went well / poorly*
  (pre-filled from facts such as ack timeouts and time to mitigate) and **action items** with owner,
  due date and checkbox. Publishing freezes the text (reopen as draft to change it) while action items
  stay tickable; export as Markdown; a Postmortems list shows follow-up progress.
- **AI-assisted postmortem drafts — used carefully.** *Generate draft* feeds the model (Claude,
  `claude-opus-5-5`) the incident metadata, alerts, responder notes, timeline and resolution —
  redacted, size-capped, every event tagged with its id — and gets back a schema-validated
  suggestion: incident summary, customer impact, probable root cause (with a confidence), response
  summary, what went well, what could improve, suggested action items and open questions. Every
  statement cites the timeline events behind it; citations of events that don't exist are stripped and
  flagged. The reviewer ticks the sections to use; applied text is badged *AI-assisted*, the root cause
  arrives as an `[Unconfirmed AI hypothesis …]`, and publishing needs an explicit "I have reviewed
  them". Runs as a worker job with retries and the dead-letter queue; without an API key a
  deterministic offline drafter (labelled as such, not as AI) keeps the workflow usable.
  **AI-generated postmortems are treated as drafts; source timeline data remains authoritative.**
- **Dashboard** — *Active incidents* worst-first with a live age ("🔴 SEV-1 Checkout unavailable
  14m"), then the last 7 / 30 / 90 days: incident count, SEV-1s, **MTTA** (mean time to acknowledge)
  and **MTTR** (mean time to resolve) with the change against the previous window, incidents per day
  stacked by severity (hover tooltip, table view), incidents per service with their MTTR, and a
  per-severity table with medians and p90s. Computed in SQL from the state machine's timestamps; the
  seed adds 60 days of history so it isn't empty on a fresh install.
- **Service health** derived from open incidents (SEV1 → outage, SEV2 → degraded), plus maintenance
  windows that record alerts without paging.
- **Multi-tenant** (organizations), with `admin` / `responder` roles.
- **Security** — hashed API keys, per-key / bad-key / login rate limits, RBAC, httpOnly
  `SameSite=Strict` session cookies, Origin-checked CSRF protection, pinned-algorithm JWTs (and a
  refusal to run a real install with a weak secret), zod validation, parameterized SQL, tenant
  isolation, audit log (including sign-ins), signed webhooks with an SDK verifier, an SSRF guard that
  survives DNS rebinding, security headers, CodeQL, dependency audit and Dependabot. Threat model
  (STRIDE per trust boundary, residual risks) in [docs/threat-model.md](docs/threat-model.md).
- **Failure handling** — keeps accepting alerts while Redis is down (pages follow once it's back),
  answers `503` + `Retry-After` instead of hanging while Postgres is down and survives a database
  restart, `Idempotency-Key` on ingestion (the SDK sends one per call, so a retry after a lost
  response never records an alert twice), delivery leases so a crashed or duplicated worker job never
  pages twice in parallel, and liveness vs. readiness health checks. Every "what if…?" is answered in
  [docs/failure-handling.md](docs/failure-handling.md) with the test that proves it.

## Architecture

```
            ┌──────────────┐     REST + SSE      ┌──────────────┐
 Browser ──►│  apps/web    │ ──────────────────► │  apps/api    │◄── monitoring tools
            │  Next.js     │                     │  Express     │    (API keys)
            └──────────────┘                     └──┬───────┬───┘
                                                    │       │ enqueue jobs / publish events
                                          SQL (tx)  │       ▼
                                                    │   ┌────────┐  pub/sub  ┌──────────────┐
                                                    │   │ Redis  │◄─────────►│ apps/worker  │
                                                    ▼   └────────┘  BullMQ   │ escalations, │
                                              ┌────────────┐  (+ dead-letter │ notifications│
                                              │ PostgreSQL │◄──── queue)─────│ sweeper      │
                                              └────────────┘                 └──────────────┘
```

| Path | What it is |
| --- | --- |
| [`apps/api`](apps/api) | Express + TypeScript REST API: ingestion, incidents, services, postmortems, audit log, SSE stream |
| [`apps/worker`](apps/worker) | BullMQ worker: escalation policies, notification delivery, recovery sweeper |
| [`apps/web`](apps/web) | Next.js (App Router) + Tailwind dashboard |
| [`packages/database`](packages/database) | Plain-SQL migrations, migration runner, seed data, pool + transaction helper, test fixtures |
| [`packages/shared`](packages/shared) | Domain types, zod schemas, state machine, rule engine, dedup, postmortem generator (pure, unit-tested) |
| [`apps/simulator`](apps/simulator) | `npm run demo:incident` and the smaller `npm run simulate` scenarios, sent over HTTP with the SDK |
| [`packages/alert-sdk`](packages/alert-sdk) | `@incident-platform/sdk`: the publishable client for applications (alerts, resolves, exceptions, job monitoring) + an example service |
| [`docker`](docker) | Dockerfile (one build target per app) |
| [`docs`](docs) | [Architecture & design decisions](docs/architecture.md), [Threat model](docs/threat-model.md), [Incident lifecycle](docs/incident-lifecycle.md), [Failure handling](docs/failure-handling.md), [API reference](docs/api.md), [Testing](docs/testing.md) |

Stack: TypeScript everywhere, Node.js 22, Express 5, PostgreSQL 16 (raw SQL via `pg`),
Redis 7, BullMQ, Next.js 16 / React 19, Tailwind 4, zod, Vitest, Docker Compose, GitHub Actions.

### Engineering decisions worth a look

Details and trade-offs in [docs/architecture.md](docs/architecture.md).

1. **Deduplication races are settled by the database.** A partial unique index allows only one
   *open* incident per `(service, dedup_key)`. Concurrent alerts `INSERT … ON CONFLICT DO NOTHING`
   and the loser joins the winner's incident.
2. **One place changes incident status.** `changeStatus()` row-locks the incident, checks the
   shared state machine (mirrored by a Postgres trigger, and a test keeps the two in sync), stamps timestamps, stops escalation, writes timeline + audit, and on resolve
   pages everyone who was paged and drafts the postmortem.
3. **Side effects only after COMMIT.** Domain code records realtime events and jobs on an
   `Effects` collector; they're flushed after the transaction commits, so nobody is ever paged for
   an incident that was rolled back.
4. **Postgres is the source of truth for paging, not Redis.** Incidents store `escalation_level` and
   `next_escalation_at`; notifications are rows with a status. A sweeper re-drives anything overdue,
   so a lost queue job delays a page by seconds instead of dropping it. Escalation steps and
   deliveries are idempotent (row locks + unique index + status checks), so duplicates are harmless.
5. **Audit entries are written in the same transaction** as the change they describe.
6. **API keys are credentials, treated like passwords — but hashed for their threat model.** Keys
   are 192-bit random secrets shown once; the database stores `sha256(key)` plus a non-secret prefix
   for display. A fast hash (not bcrypt) is deliberate: there is no low-entropy secret to protect, and a
   deterministic hash allows an indexed lookup on every request. Rotation issues a new key and puts the
   old one on an expiry timer (grace period) so senders switch without dropping alerts; revocation is
   immediate. `last_used_at` is written at most once a minute per key, so a busy sender doesn't turn
   every alert into an extra row update.
7. **Rate limiting lives in Redis, as one atomic Lua script** (token bucket using Redis' clock), so
   every API instance shares the same limits. It fails open: during a Redis outage, losing alerts
   would be worse than briefly losing rate limiting.
8. **The timeline is an append-only, hash-chained audit log.** History is never edited: no code path
   updates events, database triggers refuse `UPDATE`/`DELETE`, and each event's SHA-256 covers its
   predecessor, so `timeline_verify()` pinpoints any row changed behind the application's back.
9. **SSE, not WebSockets — with replay.** Dashboards consume server-generated updates, so SSE (plain
   HTTP, cookie auth, built-in reconnects) is the simpler transport. Each event is appended to a capped
   Redis Stream and published in one atomic Lua script; its stream id is the SSE event id, so a browser
   that reconnects with `Last-Event-ID` gets exactly what it missed.
10. **AI drafts, never AI edits.** The model's answer is a separate, schema-validated row whose
    citations are checked against the incident's event log; a person applies sections, the timeline and
    metrics are never AI-written, and publishing requires a confirmed review. Inputs are redacted and
    fingerprinted (`input_digest`), and the call runs in the worker like any other slow side effect.

## Quick start

**Everything in Docker** (only Docker needed):

```sh
git clone https://github.com/kgiannopoulou/incident-response-platform.git
cd incident-response-platform
cp .env.example .env
docker compose up -d            # builds and starts web, api, worker, postgres, redis, mailpit;
                                # migrates and seeds an empty database on first start
npm run smoke                   # optional: alert → incident → email page → ack → resolve, end to end
```

```
┌───────────────────────────┐
│ web      Next.js   :3000  │   http://localhost:3000
│ api      Express   :4000  │   http://localhost:4000/health
│ worker   BullMQ           │
│ postgres 16        :5435  │
│ redis    7         :6380  │
│ mailpit  SMTP/UI   :8025  │   http://localhost:8025 (every page the worker sends)
└───────────────────────────┘
```

Every container has a healthcheck (`docker compose ps`), runs as a non-root user behind tini, and
shuts down gracefully. `docker compose run --rm migrate` re-applies migrations; with Node installed,
the plan's `npm run db:migrate` / `npm run db:seed` work against the same database too (`db:seed`
wipes and re-creates the demo data).

**Development with hot reload** (Node.js 20+): run only the infrastructure in Docker.

```sh
cp .env.example .env            # then set JWT_SECRET to a long random string
npm run infra:up                # Postgres (5435), Redis (6380), Mailpit (SMTP 1025, inbox :8025)
npm install
npm run db:migrate
npm run db:seed                 # demo org, users, services, escalation policies (wipes data!)

# three terminals
npm run dev:api                 # http://localhost:4000
npm run dev:worker
npm run dev:web                 # http://localhost:3000
```

AI postmortem drafts use Claude when `ANTHROPIC_API_KEY` is set in `.env` (model
`AI_POSTMORTEM_MODEL`, default `claude-opus-5-5`); without it the worker uses the offline,
rule-based drafter, so everything works with no account.

Sign in at http://localhost:3000 as **alex@acme.test** / **password123** (admin);
`sam@acme.test`, `jordan@acme.test` and `riley@acme.test` are responders. These are local demo accounts only.

### Simulate a production incident

No real infrastructure needed. Either click **▶ Simulate production incident** on the dashboard (as
Alex) and watch the steps light up, or run it from a terminal:

```sh
npm run demo:incident                       # CPU → latency → checkout failures → SEV1 → DB connections (~15 s)
npm run demo:incident -- --speed 5 --respond  # …and play the responders through to the AI postmortem draft
```

```
00:00  WARNING   checkout-api       CPU > 85% on checkout-7f9c                recorded
00:03  WARNING   checkout-api       Checkout p99 latency 1800ms               INC-64 opened (SEV3)
00:05  HIGH      checkout-api       Checkout error rate exceeded threshold    INC-65 opened (SEV2)
00:08  CRITICAL  checkout-api       Checkout error rate exceeded threshold    grouped into INC-65 (SEV1, 2 alerts)
00:12  CRITICAL  postgres-primary   Connection pool exhausted (500/500)       INC-66 opened (SEV1)
00:15  CRITICAL  checkout-api       Checkout error rate exceeded threshold    grouped into INC-65 (SEV1, 3 alerts)

— responders (Sam Rivera) —
00:18  Sam       acknowledges INC-65                                          ok
00:21  Sam       starts investigating                                         ok
00:24  Sam       notes "Database connections appear exhausted (500/500)"      ok
 …
00:38  monitor   monitoring clears the alerts                                 5 alert(s) cleared
00:41  Sam       resolves INC-65        already resolved — the service auto-resolves when monitoring clears its alerts
00:44  Sam       asks for an AI postmortem draft                              draft requested → …/incidents/65/postmortem
```

More focused scenarios:

```sh
npm run simulate                # "checkout is down": 5xx alerts (grouped) + payment timeouts
npm run simulate -- storm       # 4 repeats of one alert -> 1 incident (Alerts: 4); HIGH then CRITICAL raises SEV2 -> SEV1
npm run simulate -- noise       # INFO/WARNING (recorded), staging alert (suppressed), latency (rule → SEV3)
npm run simulate -- recover     # monitoring clears the alerts → Checkout auto-resolves
```

Watch the dashboard update live, see the Payments team (Sam, Jordan) paged by email in the Mailpit
inbox (http://localhost:8025), and leave the SEV1 unacknowledged: after two minutes its
acknowledgement timeout fires and pages Alex early (step 2 would otherwise wait until minute 5),
and at minute ten Riley is paged. Then then acknowledge, add notes, resolve, and open the
generated postmortem.

From an application, with the SDK:

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

```
Application ──SDK──► Alert API ──► Incident engine
```

See the [SDK README](packages/alert-sdk/README.md); `npm run example -w @incident-platform/sdk` runs
a small checkout service that reports its failures through it.

Sending an alert from anything that speaks HTTP (the seeded `checkout-api` service's dev key):

```sh
curl -X POST http://localhost:4000/api/v1/alerts \
  -H "Authorization: Bearer ir_live_dev_checkout_api" \
  -H "Content-Type: application/json" \
  -d '{
    "service": "checkout-api",
    "severity": "critical",
    "title": "Checkout error rate exceeded threshold",
    "description": "Error rate reached 38%",
    "source": "prometheus",
    "deduplicationKey": "checkout-errors",
    "metadata": { "errorRate": 38, "region": "eu-west-1" }
  }'
```

```json
{
  "id": "alert_01M4V1JQA6G5TKEBVMPF8Z6DPZ",
  "status": "triggered",
  "receivedAt": "2026-10-13T16:29:54Z",
  "service": "checkout-api",
  "deduplicationKey": "checkout-errors",
  "decision": "incident_created",
  "reason": "Default rule: critical/high alerts open an incident",
  "incident": { "id": 64, "number": 64, "status": "triggered" }
}
```

New services get a random key (`ir_live_` + 48 hex chars) that is shown once; manage keys under
**Services → API keys** (create, rotate with a grace period, revoke). `npm run simulate -- burst`
sends 150 alerts back to back to show the rate limiter answering `429`.

## Data model

```mermaid
erDiagram
  organizations ||--o{ organization_members : has
  users ||--o{ organization_members : "belongs to"
  organizations ||--o{ teams : has
  teams ||--o{ team_members : has
  organizations ||--o{ escalation_policies : has
  escalation_policies ||--o{ escalation_steps : "ordered steps"
  escalation_steps ||--o{ escalation_step_targets : "users / teams"
  organizations ||--o{ services : has
  services ||--o{ alert_rules : "ordered rules"
  services ||--o{ alerts : receives
  services ||--o{ incidents : affects
  incidents ||--o{ incident_alerts : groups
  alerts ||--o{ incident_alerts : "grouped into"
  incidents ||--o{ incident_responders : has
  incidents ||--o{ timeline_events : has
  incidents ||--o{ notifications : "pages (email)"
  organizations ||--o{ webhook_endpoints : has
  webhook_endpoints ||--o{ webhook_deliveries : "signed POSTs"
  incidents ||--o| postmortems : has
  organizations ||--o{ audit_log : records
```

The full schema, with comments on every table, is in
[`packages/database/migrations/0001_init.sql`](packages/database/migrations/0001_init.sql).

## Testing

**285 tests**, mostly integration tests against a real Postgres and Redis — see
[docs/testing.md](docs/testing.md) for the strategy, coverage per workspace and what the tests found.

```sh
npm test                # all workspaces (needs the docker compose Postgres + Redis running)
npm run test:coverage   # the same, with coverage (CI runs this and uploads the summaries)
npm run typecheck
npm run lint
```

The four business rules the plan singles out, each tested through the public interface:

| Rule | Test |
| --- | --- |
| `triggered → acknowledged ✓` · `acknowledged → investigating ✓` · `investigating → resolved ✓` · `resolved → investigating ✗` | The table over HTTP (409, row unchanged), all 20 pairs over HTTP, the 5 × 5 matrix, 2,000 random walks |
| 100 alerts with the same key → **1 incident, 100 attached alerts** | Sequentially *and* all 100 at once (one `incident_created`, 99 `grouped`, one page) |
| Notification attempt 1 → failure, 2 → failure, **3 → success** | Real BullMQ workers with production job options: email, webhooks and AI drafts; all-fail → dead-lettered once |
| **Org A cannot read Org B incidents** | 36 id-addressed routes called by Org B's *admin* with Org A's ids → all `404`, Org A unchanged; 16 lists clean; per-tenant incident numbers; tenant-bound API keys; 16 admin-only routes vs responders |

The 100-concurrent-alerts test found a **deadlock** (a `FOR UPDATE` on the service row conflicting with
foreign-key share locks held by in-flight alerts) that 10 concurrent alerts never triggered — fixed
with `FOR NO KEY UPDATE`; details in [docs/testing.md](docs/testing.md#what-these-tests-found).

- **Unit** (`packages/shared`, `packages/alert-sdk`): alert payload validation, ULID ids, API key
  generation/hashing, state machine, rule engine, dedup keys, postmortem generator, SDK retries and
  `Retry-After` handling.
- **Integration** (`apps/api`, `apps/worker`): run against a real Postgres test database
  (`incidents_test`, created and migrated automatically) and Redis. They cover ingestion,
  grouping, the concurrent-alert race, concurrent acknowledgements, the lifecycle and its
  timeline/audit trail, auto-resolve, tenant isolation, roles, alert rules,
  SSE delivery and isolation, escalation level by level, idempotent paging, notification retries,
  and sweeper recovery after a lost queue. Phases 5–10 added suites for **correlation** (four alerts →
  one incident, severity raising, recurrence), the **state machine** (every forbidden move is a 409,
  and the API's table and the database trigger agree on all 25 pairs), **on-demand escalation**, the
  **immutable timeline** (UPDATE/DELETE refused by Postgres, concurrent appends keep the chain
  intact, edited or deleted rows are pinpointed), **realtime** (two browsers, ordered event ids,
  replay after a disconnect, resync) and **responder roles** (one commander even under racing
  hand-overs, read-only observers, permissions). The API-key suite checks that the plaintext key appears
  nowhere in the database, rotation grace periods and expiry, immediate revocation, throttled
  last-used timestamps, per-key token buckets with headers, and the bad-key IP lock-out.
- **Phases 11–15**: **escalation policies** (CRUD, admin-only writes, ordering/target validation,
  tenant isolation, delete refused while in use, steps scheduled from the trigger time), the
  **dead-letter queue** (a page failing all 5 attempts lands there with its error and organization;
  retry resets the row and re-enqueues; tenant-scoped; audited), worker heartbeats and the retry
  policy, **notifications** (webhook fan-out only to enabled, subscribed endpoints of the right
  tenant; signatures verified by a real local receiver; non-2xx retried then failed; `410` disables;
  SSRF guard; secrets returned once and never listed; email subject and links), the
  **acknowledgement timeout** (armed only for high-urgency incidents of policies with a timeout;
  acknowledging cancels the delayed job; severity raise/lower arms/disarms; fires once even with job +
  sweeper racing; pages the next step early while the regular schedule continues; recovered by the
  sweeper after Redis loses the job) and **postmortems** (timeline entries all trace to real
  hash-chained events, alert runs collapsed, hidden entries survive a refresh, publish blocked while the
  root cause is a placeholder, published text is read-only but action items can still be ticked off,
  reopen, Markdown export without hidden entries, tenant isolation).
- **Phase 17 (metrics)**: MTTA/MTTR means, medians and p90 against hand-computed values, open
  incidents counted for MTTA but not MTTR, the previous-window comparison, all four severities and
  every service present with zeros, one bucket per UTC day, active incidents ordered worst-first then
  oldest, tenant isolation and the allowed windows.
- **Phase 20 (testing)**: the four rules above, plus coverage reporting in CI.
- **Phase 19 (SDK)**: the plan's `alert({ severity, title, deduplicationKey })` call on the wire,
  env-var defaults, client-side validation, retries for 5xx / network errors / timeouts with an
  identical body, `Retry-After`, no retries for 4xx, `onError` modes, exception fingerprints (ids and
  line numbers ignored, different error types kept apart), `monitor()` alert-then-resolve, and
  **end to end against the real API over HTTP**: repeats grouped into one incident, the same exception
  thrown three times is one incident with three alerts, `resolve` auto-resolves, bad keys and foreign
  services surface as typed errors.
- **Phase 18 (simulator)**: the dashboard button plays the scenario through the real ingestion
  pipeline (decisions, grouping, the SEV2 → SEV1 raise, paging job, `metadata.simulated` on every
  alert, audit entry), one run per organization, admin-only, valid speeds; the CLI's argument
  parsing, clock and responder script, and that every scenario step is a valid alert payload.
- **Phase 16 (AI drafts)**: redaction (API keys, tokens, emails and IPs never reach the model), alert
  storms collapsed, long timelines capped head + tail, the prompt fences incident data, hallucinated
  citations are stripped with a warning, refusals / truncation / bad keys fail at once while rate limits
  are retried, the sweeper recovers lost jobs, the exact request sent to Claude (structured output,
  server-side fallback) via a fake client, and the review gate: only chosen sections are applied, the
  timeline and metrics never change, publishing needs a confirmed review and a confirmed root cause.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every push and pull request,
as parallel jobs:

```
Push / Pull Request
        │
        ├── ESLint ──────────── Node workspaces + Next.js rules
        ├── TypeScript check ── every workspace
        ├── Unit tests ──────── shared logic, SDK, simulator (with coverage)
        ├── Integration tests ─ API + worker against Postgres 16 + Redis 7 service containers (with coverage)
        ├── Build ───────────── Next.js production build; SDK compiled, packed and smoke-imported
        └── Docker ──────────── all images built, `docker compose up --wait`, end-to-end smoke test
```

**Delivery** ([`.github/workflows/release.yml`](.github/workflows/release.yml)): pushing a version
tag (`v1.0.0`) re-runs the whole CI, then publishes the `api`, `worker` and `web` images to GitHub
Container Registry (`ghcr.io/kgiannopoulou/fireline-*`, tagged with the version and `latest`) and
creates a GitHub release with the packed SDK attached. Run a release without building:

```sh
FIRELINE_VERSION=1.0.0 docker compose -f docker-compose.yml -f deploy/docker-compose.images.yml up -d --no-build
```

## Roadmap

- An eval set for the AI drafter (citation validity, root-cause agreement, invented facts) before
  changing its prompt or model
- On-call schedules (rotations) as escalation targets instead of fixed users
- SMS / push / Slack-app channels and per-user notification preferences (contact methods)
- Status page for customers, driven by service status
- Scoped API keys (e.g. trigger-only vs. resolve) and per-organization quotas
- Slack slash-commands to acknowledge/resolve from chat
