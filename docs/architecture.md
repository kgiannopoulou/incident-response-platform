# Architecture & design decisions

This document explains *why* the platform is built the way it is. The README covers what it does
and how to run it.

## Components

| Component | Responsibility | Talks to |
| --- | --- | --- |
| **API** (`apps/api`) | Validates and ingests alerts, owns every write to incidents/services/postmortems, serves the dashboard's REST endpoints and the SSE stream | Postgres (all writes in transactions), Redis (publish events, enqueue jobs, subscribe for SSE) |
| **Worker** (`apps/worker`) | Escalation policies, notification delivery, periodic recovery sweep | Postgres, Redis (BullMQ consumer, publish events), notification webhook |
| **Web** (`apps/web`) | Dashboard for responders and admins | API only (REST + `EventSource`) |
| **Postgres** | Source of truth for everything, including "who still needs to be paged" | — |
| **Redis** | BullMQ queues and pub/sub for realtime events — *never* the only copy of anything important | — |

The API and worker are stateless and can be scaled horizontally: the API's SSE fan-out goes through
Redis pub/sub, and the worker's correctness relies on row locks, not on being the only worker.

## Alert ingestion

`POST /api/v1/alerts` authenticates with a per-service integration key. Keys are random 192-bit
secrets returned once on creation/rotation; only their SHA-256 hash is stored, so a database leak
doesn't leak working keys. The key identifies both the organization and the service, so a monitoring
tool can't send alerts into another tenant.

Inside one transaction:

1. **Dedup key** — the client's `dedupKey`, or `sha256(service | source | normalized summary)`.
   Normalization lower-cases, collapses whitespace and masks numbers, so
   `p99 latency 2300ms` and `p99 latency 2410ms` are the same alert.
2. **Maintenance** — alerts for a service in maintenance are stored as `suppressed`; nobody is paged.
3. **Grouping first** — if an open incident exists for `(service, dedup key)` the alert is attached
   to it (`SELECT … FOR UPDATE`), whatever the rules would say about a fresh alert.
4. **Rules** — the service's ordered rules (`packages/shared/src/rules.ts`, a pure function) decide:
   create an incident (optionally overriding severity), record only, or suppress. Default: critical
   and error alerts open incidents; warning and info are recorded.
5. **Create** — see the race below.

The endpoint returns `202 Accepted` with the decision (`incident_created`, `grouped`, `recorded`,
`suppressed`, `maintenance`, `resolved`) so integrations and tests can see exactly what happened.

### The duplicate-alert race

Monitoring systems fire bursts. Two identical alerts arriving together would both see "no open
incident" and both create one. The fix lives in the schema:

```sql
CREATE UNIQUE INDEX incidents_open_dedup_idx
  ON incidents (service_id, dedup_key)
  WHERE status <> 'resolved' AND dedup_key IS NOT NULL;
```

Creation uses `INSERT … ON CONFLICT (service_id, dedup_key) WHERE … DO NOTHING RETURNING *`. The
loser gets no row back, re-reads the winner's incident and groups its alert into it. Incident numbers
come from `UPDATE organizations SET incident_counter = incident_counter + 1 RETURNING …`, which
row-locks the organization and also serializes concurrent creations within a tenant. The integration
test fires 10 identical alerts in parallel and asserts one incident with `alert_count = 10`.

The partial index also governs **reopening**: a resolved incident can't be reopened while a newer
open incident tracks the same alert (409 instead of a duplicate).

## Incident lifecycle

The state machine is data, shared by API and UI (`packages/shared/src/lifecycle.ts`):

```
triggered → acknowledged | investigating | resolved
acknowledged → investigating | resolved
investigating → resolved
resolved → investigating   (reopen)
```

Every status change — from a responder, from `action: "resolve"` with auto-resolve, from the API —
goes through `changeStatus()` (`apps/api/src/domain/incidents.ts`), which:

- runs on an incident locked with `SELECT … FOR UPDATE`, so concurrent requests are serialized and
  the second "Acknowledge" gets a clean 409 instead of a double transition;
- stamps `acknowledged_at` / `resolved_at` and clears `next_escalation_at` (stopping escalation);
- adds the actor as responder (commander if there is none);
- writes the timeline event and the audit entry;
- on resolve, queues "resolved" notifications to everyone who was paged and drafts the postmortem;
- recomputes the service's status from its remaining open incidents.

The UI never decides what's allowed: the incident detail response includes `allowed_transitions`.

## Side effects after commit

Publishing "incident created" to browsers or enqueuing a page *before* the transaction commits
risks announcing something that then rolls back. Domain functions therefore record effects on an
`Effects` collector (`apps/api/src/lib/effects.ts`); `runTx()` flushes it only after `COMMIT`.

The opposite failure — commit succeeded, process died before flushing — is covered by the next point.

## Postgres as the source of truth for paging

A queue is a great trigger and a poor ledger. So:

- **Escalation state lives on the incident**: `escalation_level` (last level paged) and
  `next_escalation_at` (when the next level is due; `NULL` = nothing to do).
- **Notifications are rows** with `queued → sent | failed`, attempts and last error.
- Queue jobs carry only ids; the worker always re-reads current state.
- A **sweeper** (an in-process timer in every worker, every 10 s) escalates anything with
  `next_escalation_at <= now()` and re-enqueues notifications stuck in `queued`. It is deliberately
  *not* a BullMQ repeatable job: a scheduler stored in Redis would vanish together with the queue
  state it is meant to recover.

So if Redis is flushed, or the API crashes between COMMIT and enqueue, a page is delayed by seconds,
never lost. Duplicates are harmless because every step is idempotent:

- `escalateIncident()` locks the incident and acts only if the step is still due — five concurrent
  calls page once (tested);
- `notifications_once_per_level_idx` makes a person's page per level unique;
- delivery only sends rows still `queued`, and BullMQ job ids (`notification-<id>`) dedupe the queue.
  Finished jobs are removed rather than retained, so that dedup only applies to jobs still in flight
  (a retained completed job would make BullMQ silently drop a later job with the same id — a bug the
  worker test suite reproduces).

Delivery failures are retried with exponential backoff (5 attempts); the row is marked `failed` with
the error after the last one and shown in the incident's paging panel.

## Realtime updates

The browser opens one `EventSource` to `/api/v1/stream` (cookie-authenticated). The API and the
worker publish small "something changed" events to `irp:events:org:<id>` on Redis; each API process
holds one pattern subscription and writes each event only to that organization's connections.
Clients re-fetch the affected resource rather than trusting event payloads, which keeps events tiny
and the REST API the single source of truth. Heartbeat comments keep proxies from closing idle
streams, and `retry: 3000` makes browsers reconnect automatically.

## Multi-tenancy and authorization

Every business table has `organization_id`; every query filters on the organization from the JWT
(or from the integration key). Incident routes use the per-organization number (`INC-42`), so
tenant B's `INC-1` is a different incident from tenant A's `INC-1`, and there is no global id to guess.
Cross-references (adding a responder, choosing a team or escalation policy) are checked to belong to
the same organization. Roles: `admin` manages services, rules and keys and can read the audit log;
`responder` works incidents. Tests cover isolation for REST, ingestion and SSE.

Sessions are JWTs in an httpOnly, `SameSite=Lax` cookie (`Secure` when `COOKIE_SECURE=true`), with
`Authorization: Bearer` accepted for scripts.

## Postmortems

`buildPostmortemDraft()` is a pure function over the incident, its alerts, timeline and responders.
It computes time-to-acknowledge, time-to-resolve, alert / escalation / note / responder counts, writes
first drafts of each section (summary, impact, the first signal as a root-cause starting point, and
the resolution message), suggests action items from what happened (escalations before acknowledgement,
slow acknowledgement, alert noise, no alert at all) and renders the timeline. It runs automatically
when an incident is resolved; "Refresh data" re-computes metrics and timeline without overwriting the
narrative a responder has written.

## What I'd do next for production

- **Outbox table** instead of post-commit flush + sweeper, if more event types need guaranteed delivery.
- **Partitioning / retention** for `alerts`, `timeline_events` and `audit_log`.
- **Rate limiting** per integration key, and request size quotas.
- **On-call schedules** as escalation targets; email/SMS channels.
- **OpenTelemetry** traces across API → queue → worker.
