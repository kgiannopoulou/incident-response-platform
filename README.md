# Fireline — Incident Response Platform

A small, PagerDuty/Opsgenie-style incident management platform. Monitoring tools send
alerts; the platform deduplicates them, applies matching rules, opens incidents, pages
the on-call responder and escalates if nobody answers. Responders then work the
incident (acknowledge, investigate, resolve) on a live timeline, and when it's resolved
a postmortem draft is generated from what actually happened.

> "Our checkout service is down." — follow it from the first automated alert →
> incident → page → escalation → acknowledgement → resolution → postmortem.

![Dashboard](docs/screenshots/dashboard.jpg)

| Escalation, live | Generated postmortem |
| --- | --- |
| ![Incident with escalation](docs/screenshots/incident-escalation.jpg) | ![Postmortem](docs/screenshots/postmortem.jpg) |

## The workflow

```
Monitoring tool / app ──POST /api/v1/alerts──► Alert ingestion
                                                    │  dedup key (service + source + summary, numbers masked)
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

- **Alert ingestion API** with per-service integration keys (stored hashed), PagerDuty-style
  `trigger` / `resolve` events, and a tiny [SDK](packages/alert-sdk) with retries.
- **Deduplication & grouping** — repeats of the same problem join the open incident instead
  of paging again. Safe under concurrency: 10 simultaneous identical alerts open exactly one incident.
- **Matching rules** per service (first match wins): open an incident with a severity override,
  record only, or suppress (e.g. staging noise). Sensible default when no rule matches.
- **Incident lifecycle** enforced by a state machine (`triggered → acknowledged → investigating →
  resolved`, plus reopen), with row locking so two people clicking *Acknowledge* can't both win.
- **Escalation policies** — multi-level, users or whole teams, per-level delays; acknowledging stops it.
- **Notifications** via a background worker (BullMQ) with retries/backoff; delivered to a
  Slack-compatible webhook, or logged when none is configured.
- **Live updates** over Server-Sent Events, fanned out through Redis pub/sub so events from the
  API *and* the worker reach every open browser.
- **Timeline + audit trail** — every incident has an append-only timeline; every change in the
  organization is written to the audit log in the same transaction as the change.
- **Postmortems** — drafted automatically on resolve (summary, impact, first signal, resolution,
  MTTA/MTTR, alert/escalation counts, suggested action items, generated timeline), then edited and published.
- **Service health** derived from open incidents (SEV1 → outage, SEV2 → degraded), plus maintenance
  windows that record alerts without paging.
- **Multi-tenant** (organizations), with `admin` / `responder` roles.

## Architecture

```
            ┌──────────────┐     REST + SSE      ┌──────────────┐
 Browser ──►│  apps/web    │ ──────────────────► │  apps/api    │◄── monitoring tools
            │  Next.js     │                     │  Express     │    (integration keys)
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
   shared state machine, stamps timestamps, stops escalation, writes timeline + audit, and on resolve
   pages everyone who was paged and drafts the postmortem.
3. **Side effects only after COMMIT.** Domain code records realtime events and jobs on an
   `Effects` collector; they're flushed after the transaction commits, so nobody is ever paged for
   an incident that was rolled back.
4. **Postgres is the source of truth for paging, not Redis.** Incidents store `escalation_level` and
   `next_escalation_at`; notifications are rows with a status. A sweeper re-drives anything overdue,
   so a lost queue job delays a page by seconds instead of dropping it. Escalation steps and
   deliveries are idempotent (row locks + unique index + status checks), so duplicates are harmless.
5. **Audit entries are written in the same transaction** as the change they describe.

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
npm run simulate -- noise       # warning (recorded), staging alert (suppressed), latency (rule → SEV3)
npm run simulate -- recover     # monitoring clears the alerts → Checkout auto-resolves
```

Watch the dashboard update live, see Sam paged in the worker log, wait two minutes without
acknowledging to watch it escalate to Alex, then acknowledge, add notes, resolve, and open the
generated postmortem.

Sending an alert from anything that speaks HTTP:

```sh
curl -X POST http://localhost:4000/api/v1/alerts \
  -H "Authorization: Bearer dev-key-checkout-api" \
  -H "Content-Type: application/json" \
  -d '{"summary":"Checkout API 5xx rate above 5%","severity":"critical","source":"prometheus"}'
```

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

- **Unit** (`packages/shared`, `packages/alert-sdk`): state machine, rule engine, dedup keys,
  postmortem generator, SDK retry behaviour.
- **Integration** (`apps/api`, `apps/worker`): run against a real Postgres test database
  (`incidents_test`, created and migrated automatically) and Redis. They cover ingestion,
  grouping, the concurrent-alert race, concurrent acknowledgements, the lifecycle and its
  timeline/audit trail, auto-resolve, reopen conflicts, tenant isolation, roles, alert rules,
  SSE delivery and isolation, escalation level by level, idempotent paging, notification retries,
  and sweeper recovery after a lost queue.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck, lint, all tests
against Postgres/Redis service containers, the web production build, and the Docker image build.

## Roadmap

- On-call schedules (rotations) as escalation targets instead of fixed users
- Email/SMS channels and per-user notification preferences
- Status page for customers, driven by service status
- Rate limiting and payload size quotas per integration key
- Slack slash-commands to acknowledge/resolve from chat
