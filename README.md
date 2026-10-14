# Fireline — Incident Response Platform

A small, PagerDuty/Opsgenie-style incident management platform. Monitoring tools send
alerts; the platform deduplicates them, applies matching rules, opens incidents, pages
the on-call responder and escalates if nobody answers. Responders then work the
incident (acknowledge, investigate, mitigate, resolve) on a live timeline, and when it's resolved
a postmortem draft is generated from what actually happened.

> "Our checkout service is down." — follow it from the first automated alert →
> incident → page → escalation → acknowledgement → resolution → postmortem.

![Dashboard](docs/screenshots/dashboard.jpg)

| Escalation, live | Generated postmortem |
| --- | --- |
| ![Incident with escalation](docs/screenshots/incident-escalation.jpg) | ![Postmortem](docs/screenshots/postmortem.jpg) |
| **Alert feed** | **API keys: rotation and revocation** |
| ![Alerts](docs/screenshots/alerts.jpg) | ![API keys](docs/screenshots/api-keys.jpg) |

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
  public id (`alert_01J…`, a ULID), status and receive time. PagerDuty-style `resolve` events, and a
  tiny [SDK](packages/alert-sdk) that retries and honours `Retry-After`.
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
- **Escalation policies** — multi-level, users or whole teams, per-level delays; acknowledging stops
  the automatic schedule, *Escalate* pages the next level immediately.
- **Notifications** via a background worker (BullMQ) with retries/backoff; delivered to a
  Slack-compatible webhook, or logged when none is configured.
- **Live alert feed** (🔴 CRITICAL · 🟠 HIGH · 🟡 WARNING · 🔵 INFO, "12 sec ago") and **live updates** over Server-Sent Events, fanned out through Redis pub/sub so events from the
  API *and* the worker reach every open browser.
- **Immutable timeline + audit trail** — every action is a typed timeline event (`INCIDENT_CREATED`,
  `STATUS_CHANGED {from,to}`, `NOTE_ADDED`, …). The timeline is append-only — no API to edit it, and
  Postgres triggers reject `UPDATE`/`DELETE` — and hash-chained, so tampering is detectable. Every
  change in the organization is also written to the audit log in the same transaction.
- **Postmortems** — drafted automatically on resolve (summary, impact, first signal, resolution,
  time to acknowledge / mitigate / resolve, alert/escalation counts, suggested action items, generated timeline), then edited and published.
- **Service health** derived from open incidents (SEV1 → outage, SEV2 → degraded), plus maintenance
  windows that record alerts without paging.
- **Multi-tenant** (organizations), with `admin` / `responder` roles.

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
                                              ┌────────────┐                 │ notifications│
                                              │ PostgreSQL │◄────────────────│ sweeper      │
                                              └────────────┘                 └──────────────┘
```

| Path | What it is |
| --- | --- |
| [`apps/api`](apps/api) | Express + TypeScript REST API: ingestion, incidents, services, postmortems, audit log, SSE stream |
| [`apps/worker`](apps/worker) | BullMQ worker: escalation policies, notification delivery, recovery sweeper |
| [`apps/web`](apps/web) | Next.js (App Router) + Tailwind dashboard |
| [`packages/database`](packages/database) | Plain-SQL migrations, migration runner, seed data, pool + transaction helper, test fixtures |
| [`packages/shared`](packages/shared) | Domain types, zod schemas, state machine, rule engine, dedup, postmortem generator (pure, unit-tested) |
| [`packages/alert-sdk`](packages/alert-sdk) | Client for sending alerts (with retry/backoff) + the scenario simulator |
| [`docker`](docker) | Dockerfile (one build target per app) |
| [`docs`](docs) | [Architecture & design decisions](docs/architecture.md), [API reference](docs/api.md) |

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

## Quick start

Prerequisites: Node.js 20+ and Docker.

```sh
cp .env.example .env            # then set JWT_SECRET to a long random string
docker compose up -d            # Postgres (5435) + Redis (6380)
npm install
npm run db:migrate
npm run db:seed                 # demo org, users, services, escalation policies (wipes data!)

# three terminals
npm run dev:api                 # http://localhost:4000
npm run dev:worker
npm run dev:web                 # http://localhost:3000
```

Sign in at http://localhost:3000 as **alex@acme.test** / **password123** (admin);
`sam@acme.test` and `jordan@acme.test` are responders. These are local demo accounts only.

Or run everything in containers: `docker compose --profile app up --build`
(migrates and seeds an empty database on first start).

### Play the scenario

```sh
npm run simulate                # "checkout is down": 5xx alerts (grouped) + payment timeouts
npm run simulate -- storm       # 4 repeats of one alert -> 1 incident (Alerts: 4); HIGH then CRITICAL raises SEV2 -> SEV1
npm run simulate -- noise       # INFO/WARNING (recorded), staging alert (suppressed), latency (rule → SEV3)
npm run simulate -- recover     # monitoring clears the alerts → Checkout auto-resolves
```

Watch the dashboard update live, see Sam paged in the worker log, wait two minutes without
acknowledging to watch it escalate to Alex, then acknowledge, add notes, resolve, and open the
generated postmortem.

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
  "incident": { "id": 2, "number": 2, "status": "triggered" }
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
  escalation_policies ||--o{ escalation_rules : "levels"
  organizations ||--o{ services : has
  services ||--o{ alert_rules : "ordered rules"
  services ||--o{ alerts : receives
  services ||--o{ incidents : affects
  incidents ||--o{ incident_alerts : groups
  alerts ||--o{ incident_alerts : "grouped into"
  incidents ||--o{ incident_responders : has
  incidents ||--o{ timeline_events : has
  incidents ||--o{ notifications : pages
  incidents ||--o| postmortems : has
  organizations ||--o{ audit_log : records
```

The full schema, with comments on every table, is in
[`packages/database/migrations/0001_init.sql`](packages/database/migrations/0001_init.sql).

## Testing

```sh
npm test            # all workspaces (needs the docker compose Postgres + Redis running)
npm run typecheck
npm run lint
```

- **Unit** (`packages/shared`, `packages/alert-sdk`): alert payload validation, ULID ids, API key
  generation/hashing, state machine, rule engine, dedup keys, postmortem generator, SDK retries and
  `Retry-After` handling.
- **Integration** (`apps/api`, `apps/worker`): run against a real Postgres test database
  (`incidents_test`, created and migrated automatically) and Redis. They cover ingestion,
  grouping, the concurrent-alert race, concurrent acknowledgements, the lifecycle and its
  timeline/audit trail, auto-resolve, reopen conflicts, tenant isolation, roles, alert rules,
  SSE delivery and isolation, escalation level by level, idempotent paging, notification retries,
  and sweeper recovery after a lost queue. The API-key suite checks that the plaintext key appears
  nowhere in the database, rotation grace periods and expiry, immediate revocation, throttled
  last-used timestamps, per-key token buckets with headers, and the bad-key IP lock-out.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck, lint, all tests
against Postgres/Redis service containers, the web production build, and the Docker image build.

## Roadmap

- On-call schedules (rotations) as escalation targets instead of fixed users
- Email/SMS channels and per-user notification preferences
- Status page for customers, driven by service status
- Scoped API keys (e.g. trigger-only vs. resolve) and per-organization quotas
- Slack slash-commands to acknowledge/resolve from chat
